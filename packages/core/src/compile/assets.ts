import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { Asset } from "@topik/schema";
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const markdown = unified().use(remarkParse);

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

export interface ExtractAssetsOptions {
  /** Absolute path to the compilation root (content directory). */
  baseDir: string;
  /** Absolute path to the markdown file being compiled (for resolving relative refs). */
  filePath: string;
}

export interface ExtractAssetsResult {
  /** Rewritten markdown with local image URLs replaced by asset:<id> refs. */
  content: string;
  /** Asset resources referenced by this markdown file. */
  assets: Asset[];
}

interface FoundRef {
  original: string;
  absPath: string;
  relFromBase: string;
}

export async function extractAssets(
  source: string,
  options: ExtractAssetsOptions,
): Promise<ExtractAssetsResult> {
  const { baseDir, filePath } = options;
  const tree = markdown.parse(source) as Root;

  const refs = new Map<string, FoundRef>();
  const collectRef = (url: string) => {
    if (!isLocalRef(url)) return;
    if (refs.has(url)) return;
    const absPath = resolveAssetPath(url, { baseDir, filePath });
    const relFromBase = relative(baseDir, absPath).split(sep).join(posix.sep);
    refs.set(url, { original: url, absPath, relFromBase });
  };

  visit(tree, (node) => {
    if (node.type === "image") {
      collectRef(node.url);
    } else if (node.type === "link") {
      if (hasKnownAssetExtension(node.url)) collectRef(node.url);
    } else if (node.type === "definition") {
      if (hasKnownAssetExtension(node.url)) collectRef(node.url);
    }
  });

  if (refs.size === 0) {
    return { content: source, assets: [] };
  }

  const urlToId = new Map<string, string>();
  const byName = new Map<string, Asset>();
  await Promise.all(
    Array.from(refs.values()).map(async (ref) => {
      const asset = await toAsset(ref);
      urlToId.set(ref.original, asset.name);
      byName.set(asset.name, asset);
    }),
  );

  const rewritten = rewriteUrls(source, urlToId);
  return { content: rewritten, assets: Array.from(byName.values()) };
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

function rewriteUrls(source: string, urlToId: Map<string, string>): string {
  const tree = markdown.parse(source) as Root;
  const edits: Array<{ start: number; end: number; replacement: string }> = [];

  visit(tree, (node) => {
    if (node.type !== "image" && node.type !== "link" && node.type !== "definition") return;
    const id = urlToId.get(node.url);
    if (!id) return;
    const pos = node.position;
    if (!pos) return;
    const start = pos.start.offset;
    const end = pos.end.offset;
    if (start == null || end == null) return;
    const segment = source.slice(start, end);
    const replaced = replaceUrlInSegment(segment, node.type, node.url, `asset:${id}`);
    if (replaced == null) return;
    edits.push({ start, end, replacement: replaced });
  });

  if (edits.length === 0) return source;
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
}

function replaceUrlInSegment(
  segment: string,
  kind: "image" | "link" | "definition",
  url: string,
  replacement: string,
): string | null {
  const anchor =
    kind === "definition" ? findDefinitionUrlAnchor(segment) : findInlineUrlAnchor(segment);
  if (anchor < 0) return null;
  const urlIdx = segment.indexOf(url, anchor);
  if (urlIdx < 0) return null;
  return segment.slice(0, urlIdx) + replacement + segment.slice(urlIdx + url.length);
}

function findInlineUrlAnchor(segment: string): number {
  const idx = segment.indexOf("](");
  return idx < 0 ? -1 : idx + 2;
}

function findDefinitionUrlAnchor(segment: string): number {
  const match = /\]\s*:\s*/.exec(segment);
  return match ? match.index + match[0].length : -1;
}
