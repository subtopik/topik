import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import Markdoc, { type Node } from "@markdoc/markdoc";
import type { Asset } from "@topik/schema";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const ASSET_TAG_ATTRS = ["src", "href"];

export interface ExtractAssetsOptions {
  /** Absolute path to the compilation root (content directory). */
  baseDir: string;
  /** Absolute path to the markdown file being compiled (for resolving relative refs). */
  filePath: string;
}

export interface ExtractAssetsResult {
  /** Rewritten source with local asset URIs replaced by asset:<id> refs. */
  content: string;
  /** Asset resources referenced by this file. */
  assets: Asset[];
  /** Asset names referenced by this file, in document order, deduped. */
  manifest: string[];
}

interface FoundRef {
  original: string;
  absPath: string;
  relFromBase: string;
}

interface AttrSlot {
  node: Node;
  attr: string;
}

export async function extractAssets(
  source: string,
  options: ExtractAssetsOptions,
): Promise<ExtractAssetsResult> {
  const { baseDir, filePath } = options;
  const ast = Markdoc.parse(source);

  const refs = new Map<string, FoundRef>();
  const slots = new Map<string, AttrSlot[]>();

  const collect = (url: string, slot: AttrSlot, requireKnownExtension: boolean) => {
    if (!isLocalRef(url)) return;
    if (requireKnownExtension && !hasKnownAssetExtension(url)) return;
    if (!refs.has(url)) {
      const absPath = resolveAssetPath(url, { baseDir, filePath });
      const relFromBase = relative(baseDir, absPath).split(sep).join(posix.sep);
      refs.set(url, { original: url, absPath, relFromBase });
    }
    const list = slots.get(url) ?? [];
    list.push(slot);
    slots.set(url, list);
  };

  walk(ast, (node) => {
    if (node.type === "image") {
      const url = stringAttr(node, "src");
      if (url) collect(url, { node, attr: "src" }, false);
    } else if (node.type === "link") {
      const url = stringAttr(node, "href");
      if (url) collect(url, { node, attr: "href" }, true);
    } else if (node.type === "tag") {
      for (const attr of ASSET_TAG_ATTRS) {
        const url = stringAttr(node, attr);
        if (url) collect(url, { node, attr }, true);
      }
    }
  });

  if (refs.size === 0) {
    return { content: source, assets: [], manifest: [] };
  }

  const urlToId = new Map<string, string>();
  const byName = new Map<string, Asset>();
  const refList = Array.from(refs.values());
  const settled = await Promise.allSettled(refList.map((ref) => toAsset(ref)));
  const failures: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled") {
      urlToId.set(refList[i].original, result.value.name);
      byName.set(result.value.name, result.value);
    } else {
      failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Failed to extract ${failures.length} asset(s):\n  - ${failures.join("\n  - ")}`,
    );
  }

  const manifest: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs.values()) {
    const name = urlToId.get(ref.original);
    if (name && !seen.has(name)) {
      manifest.push(name);
      seen.add(name);
    }
  }

  for (const [url, slotList] of slots.entries()) {
    const id = urlToId.get(url);
    if (!id) continue;
    for (const slot of slotList) {
      slot.node.attributes[slot.attr] = `asset:${id}`;
    }
  }

  const content = Markdoc.format(ast);
  return { content, assets: Array.from(byName.values()), manifest };
}

function walk(node: Node, fn: (node: Node) => void): void {
  fn(node);
  for (const child of node.children) walk(child, fn);
}

function stringAttr(node: Node, attr: string): string | undefined {
  const value = node.attributes?.[attr];
  return typeof value === "string" ? value : undefined;
}

function hasKnownAssetExtension(url: string): boolean {
  const [path] = splitUrl(url);
  const decoded = decodeSafe(path);
  const m = /\.([a-z0-9]+)$/i.exec(decoded);
  if (!m) return false;
  return `.${m[1].toLowerCase()}` in MIME_BY_EXT;
}

function isLocalRef(url: string): boolean {
  if (url.length === 0) return false;
  if (url.startsWith("#")) return false;
  if (url.startsWith("mailto:")) return false;
  if (url.startsWith("tel:")) return false;
  if (url.startsWith("data:")) return false;
  if (url.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  return true;
}

function resolveAssetPath(
  url: string,
  { baseDir, filePath }: { baseDir: string; filePath: string },
): string {
  const [pathPart] = splitUrl(url);
  const decoded = decodeSafe(pathPart);
  const anchor = isAbsolute(decoded) || decoded.startsWith("/") ? baseDir : dirname(filePath);
  const cleaned = decoded.replace(/^\/+/, "");
  const absolute = resolve(anchor, cleaned);
  const rel = relative(baseDir, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Asset reference "${url}" in ${filePath} resolves outside the compilation directory`,
    );
  }
  return absolute;
}

function splitUrl(url: string): [string, string] {
  const hashIdx = url.indexOf("#");
  const queryIdx = url.indexOf("?");
  let cut = -1;
  if (hashIdx >= 0) cut = hashIdx;
  if (queryIdx >= 0 && (cut < 0 || queryIdx < cut)) cut = queryIdx;
  if (cut < 0) return [url, ""];
  return [url.slice(0, cut), url.slice(cut)];
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function toAsset(ref: FoundRef): Promise<Asset> {
  let bytes: Buffer;
  try {
    bytes = await readFile(ref.absPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Asset "${ref.original}" not found at ${ref.absPath}: ${message}`, {
      cause: error,
    });
  }
  const digest = createHash("sha256").update(bytes).digest();
  const integrity = `sha256-${digest.toString("base64")}`;
  // 64-bit prefix: ~50% collision odds at ~2^32 assets, plenty for content catalogs.
  const name = digest.toString("hex").slice(0, 16);
  const extMatch = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(ref.relFromBase);
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : "";
  const mediaType = MIME_BY_EXT[ext];
  return {
    apiVersion: "v1",
    type: "Asset",
    name,
    spec: { uri: ref.relFromBase, integrity, ...(mediaType ? { mediaType } : {}) },
  };
}
