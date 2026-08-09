import { createHash } from "node:crypto";
import {
  extractTopikAssetOccurrences,
  rewriteTopikAssetOccurrences,
  type TopikAssetOccurrence,
} from "@topik/content-schema";
import type { Asset } from "@topik/schema";
import { parseAllDocuments } from "yaml";
import type { Resource } from "../resource";
import { validateResources } from "../validate";
import { generateImplicitAssetName, validateStableSourceNamespace } from "./asset";
import {
  topikAssetDiagnostic,
  type TopikAssetDiagnostic,
  type TopikAssetResult,
} from "./diagnostics";
import { readPortableAssetFile } from "./files";
import { isTopikJsonDataValue, parseStrictTopikJson } from "./json";
import { isTopikActiveMediaType, sniffPortableMediaType } from "./media";
import { validateTopikPathSet } from "./path";

export interface MigrateLegacyDigestOutputOptions {
  rootDir: string;
  stableSourceNamespace: string;
}

export interface LegacyDigestMigrationResult {
  resources: Resource[];
  /** Exact caller paths and bytes. Store these before replacing legacy output. */
  backup: LegacyDigestOutputFile[];
}

export interface LegacyDigestOutputFile {
  path: string;
  bytes: Uint8Array;
}

interface LegacyAsset {
  apiVersion: "v1";
  type: "Asset";
  name: string;
  labels?: Record<string, string>;
  spec: { uri: string; integrity: string; mediaType?: string };
}

const LEGACY_DOWNLOAD_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".csv",
  ".doc",
  ".docx",
  ".flac",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mp3",
  ".mp4",
  ".ogg",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".svg",
  ".tar",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);

/** Migrate the public 16-hex digest output without accepting partial or remote sets. */
export async function migrateLegacyDigestOutput(
  input: string | Uint8Array | readonly { path: string; bytes: string | Uint8Array }[],
  options: MigrateLegacyDigestOutputOptions,
): Promise<TopikAssetResult<LegacyDigestMigrationResult>> {
  const scalarInput = typeof input === "string" || input instanceof Uint8Array;
  const failureSource = scalarInput
    ? typeof input === "string"
      ? new TextEncoder().encode(input)
      : Uint8Array.from(input)
    : undefined;
  const suppliedFiles = scalarInput
    ? [{ path: "legacy-output.json", bytes: failureSource as Uint8Array }]
    : input.map((file) => ({
        path: file.path,
        bytes:
          typeof file.bytes === "string"
            ? new TextEncoder().encode(file.bytes)
            : Uint8Array.from(file.bytes),
      }));
  const inputPaths = validateTopikPathSet(suppliedFiles.map((file) => file.path));
  if (!inputPaths.ok) return failure(inputPaths.diagnostics, failureSource);
  const backup = [...suppliedFiles]
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }));
  let inputResources: unknown[];
  try {
    inputResources = backup.flatMap(parseLegacyResourceFile);
  } catch {
    return invalid(
      failureSource,
      "Legacy resource files are not strict supported JSON, JSONL, or YAML",
    );
  }
  if (inputResources.length === 0) {
    return invalid(failureSource, "Legacy resource file set is empty");
  }
  const resourceKeys = new Set<string>();
  for (const entry of inputResources) {
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.name !== "string") {
      return invalid(failureSource, "Legacy resource set contains a malformed resource");
    }
    const key = `${entry.type}/${entry.name}`;
    if (resourceKeys.has(key))
      return invalid(failureSource, "Legacy resource identity is duplicated");
    resourceKeys.add(key);
  }
  const namespace = validateStableSourceNamespace(options.stableSourceNamespace);
  if (!namespace.ok) {
    return failure(namespace.diagnostics, failureSource);
  }

  const legacyAssets = inputResources.filter(isLegacyAsset);
  if (
    legacyAssets.length !==
    inputResources.filter((entry) => isRecord(entry) && entry.type === "Asset").length
  ) {
    return invalid(failureSource, "Legacy Asset set is malformed or uses unsupported remote input");
  }
  const paths = legacyAssets.map((asset) => asset.spec.uri);
  const pathSet = validateTopikPathSet(paths);
  if (!pathSet.ok) return failure(pathSet.diagnostics, failureSource);
  const oldNames = new Set<string>();
  const newNames = new Set<string>();
  const nameMap = new Map<string, string>();
  const migratedAssets: Asset[] = [];
  const allReferenced = new Set<string>();

  for (const legacy of legacyAssets) {
    if (oldNames.has(legacy.name)) return invalid(failureSource, "Legacy Asset name is duplicated");
    oldNames.add(legacy.name);
    const generated = generateImplicitAssetName({
      stableSourceNamespace: namespace.value,
      normalizedPath: legacy.spec.uri,
    });
    if (!generated.ok) return failure(generated.diagnostics, failureSource);
    if (newNames.has(generated.value))
      return invalid(failureSource, "Migrated Asset name collides");
    newNames.add(generated.value);
    nameMap.set(legacy.name, generated.value);
    const read = await readPortableAssetFile({ root: options.rootDir, path: legacy.spec.uri });
    if (!read.ok || read.value.bytes === undefined) {
      return failure(read.diagnostics, failureSource);
    }
    const digest = createHash("sha256").update(read.value.bytes).digest();
    if (legacy.name !== digest.toString("hex").slice(0, 16)) {
      return invalid(failureSource, "Legacy Asset name does not match its digest-prefix identity");
    }
    if (`sha256-${digest.toString("base64")}` !== legacy.spec.integrity) {
      return {
        ok: false,
        diagnostics: [
          topikAssetDiagnostic(
            "TOPIK_ASSET_DIGEST_MISMATCH",
            "Legacy integrity differs from source bytes",
            {
              location: { key: legacy.name, path: legacy.spec.uri },
              recovery: "verify-bytes",
            },
          ),
        ],
        ...(failureSource === undefined ? {} : { source: failureSource }),
      };
    }
    const mediaType = sniffPortableMediaType(read.value.bytes);
    if (isTopikActiveMediaType(mediaType)) {
      return {
        ok: false,
        diagnostics: [
          topikAssetDiagnostic(
            "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED",
            "Legacy Asset contains unsupported active content",
            { location: { key: legacy.name, path: legacy.spec.uri } },
          ),
        ],
        ...(failureSource === undefined ? {} : { source: failureSource }),
      };
    }
    migratedAssets.push({
      apiVersion: "v1",
      type: "Asset",
      name: generated.value,
      ...(legacy.labels === undefined ? {} : { labels: { ...legacy.labels } }),
      spec: {
        uri: legacy.spec.uri,
        integrity: `sha256:${digest.toString("hex")}`,
        size: read.value.bytes.byteLength,
        mediaType,
      },
    });
  }

  const migratedResources: Resource[] = [];
  for (const entry of inputResources) {
    if (isLegacyAsset(entry)) continue;
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.name !== "string") {
      return invalid(failureSource, "Legacy resource set contains a malformed resource");
    }
    if (entry.type !== "Guide" && entry.type !== "WikiPage") {
      migratedResources.push(structuredClone(entry) as Resource);
      continue;
    }
    if (
      !isRecord(entry.spec) ||
      !isRecord(entry.spec.content) ||
      typeof entry.spec.content.value !== "string"
    ) {
      return invalid(failureSource, "Legacy content resource is malformed");
    }
    if (
      entry.spec.assets !== undefined &&
      (!Array.isArray(entry.spec.assets) ||
        entry.spec.assets.some((name) => typeof name !== "string" || !oldNames.has(name)))
    ) {
      return invalid(
        failureSource,
        "Legacy content resource has a malformed or partial Asset list",
      );
    }
    if (entry.spec.assets === undefined) {
      const occurrences = extractTopikAssetOccurrences(entry.spec.content.value, {
        includeGenericLinkCandidates: true,
      });
      if (occurrences.some(isUnmigratableUnsafeOccurrence)) {
        return invalid(failureSource, "Legacy content contains an unsafe Asset-capable reference");
      }
      if (
        occurrences.some(
          (occurrence) =>
            isUnreconciledLegacyAssetOccurrence(occurrence) ||
            occurrence.reference.startsWith("asset:") ||
            occurrence.parsedReference.startsWith("asset:"),
        )
      ) {
        return invalid(failureSource, "Legacy content references an Asset without an Asset list");
      }
      migratedResources.push(structuredClone(entry) as Resource);
      continue;
    }
    const legacyAssetList = (entry.spec.assets ?? []) as string[];
    const referenced = new Set<string>();
    let content: string;
    try {
      content = rewriteTopikAssetOccurrences(
        entry.spec.content.value,
        (occurrence) => {
          if (isUnmigratableUnsafeOccurrence(occurrence)) throw new Error("malformed");
          if (isUnreconciledLegacyAssetOccurrence(occurrence) && occurrence.kind !== "asset") {
            throw new Error("unreconciled");
          }
          if (occurrence.kind !== "asset") return undefined;
          const oldName = occurrence.reference.slice("asset:".length);
          const next = nameMap.get(oldName);
          if (next === undefined) throw new Error("missing");
          referenced.add(oldName);
          allReferenced.add(oldName);
          return `asset:${next}`;
        },
        { includeGenericLinkCandidates: true },
      );
    } catch {
      return invalid(failureSource, "Legacy content contains an unresolved Asset reference");
    }
    if (legacyAssetList.some((name) => !referenced.has(name))) {
      return invalid(failureSource, "Legacy Asset list is ambiguous or contains an unused entry");
    }
    if ([...referenced].some((name) => !legacyAssetList.includes(name))) {
      return invalid(
        failureSource,
        "Legacy content references an Asset absent from its Asset list",
      );
    }
    const spec: Record<string, unknown> = {
      ...entry.spec,
      content: { ...entry.spec.content, value: content },
    };
    delete spec.assets;
    migratedResources.push({ ...entry, spec } as Resource);
  }

  if (legacyAssets.some((asset) => !allReferenced.has(asset.name))) {
    return invalid(failureSource, "Legacy Asset set is partial or ambiguous");
  }

  const resources = [...migratedResources, ...migratedAssets].sort((left, right) =>
    compareUtf8(`${left.type}/${left.name}`, `${right.type}/${right.name}`),
  );
  if (!validateResources(resources).valid) {
    return invalid(failureSource, "Migrated resource set is invalid");
  }
  return {
    ok: true,
    value: { resources, backup },
    diagnostics: [],
    ...(failureSource === undefined ? {} : { source: failureSource }),
  };
}

function isUnreconciledLegacyAssetOccurrence(occurrence: TopikAssetOccurrence): boolean {
  if (occurrence.slot === "link.href") return isLegacyDownloadReference(occurrence.reference);
  return occurrence.kind === "local" || occurrence.kind === "asset";
}

/** Match the legacy compiler's extension-based Markdown download classification exactly. */
function isLegacyDownloadReference(reference: string): boolean {
  if (
    reference.length === 0 ||
    reference.startsWith("#") ||
    reference.startsWith("mailto:") ||
    reference.startsWith("tel:") ||
    reference.startsWith("data:") ||
    reference.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(reference)
  ) {
    return false;
  }
  const query = reference.indexOf("?");
  const fragment = reference.indexOf("#");
  const end = query < 0 ? fragment : fragment < 0 ? query : Math.min(query, fragment);
  const encodedPath = end < 0 ? reference : reference.slice(0, end);
  let path = encodedPath;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    // The legacy classifier used the original spelling when decoding failed.
  }
  const extension = /\.([a-z0-9]+)$/iu.exec(path)?.[1];
  return extension !== undefined && LEGACY_DOWNLOAD_EXTENSIONS.has(`.${extension.toLowerCase()}`);
}

function isUnmigratableUnsafeOccurrence(occurrence: TopikAssetOccurrence): boolean {
  return (
    occurrence.kind === "unsafe" &&
    (occurrence.slot !== "link.href" ||
      occurrence.reference.startsWith("asset:") ||
      occurrence.parsedReference.startsWith("asset:"))
  );
}

function parseLegacyResourceFile(file: LegacyDigestOutputFile): unknown[] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  const extension = file.path.slice(file.path.lastIndexOf(".")).toLowerCase();
  let values: unknown[];
  if (extension === ".json") {
    values = [parseStrictTopikJson(source, 12)];
  } else if (extension === ".jsonl") {
    const lines = source.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (lines.length === 0) throw new Error("Empty JSONL input");
    values = lines.map((line) => parseStrictTopikJson(line, 12));
  } else if (extension === ".yaml" || extension === ".yml") {
    const documents = parseAllDocuments(source, { strict: true, uniqueKeys: true });
    if (
      documents.length === 0 ||
      documents.some((document) => document.errors.length > 0 || document.contents === null)
    ) {
      throw new Error("Invalid YAML input");
    }
    values = documents.map((document) => document.toJS({ maxAliasCount: 0 }));
  } else {
    throw new Error("Unsupported legacy resource extension");
  }
  if (values.some((value) => !isTopikJsonDataValue(value))) {
    throw new Error("Legacy resource is not prototype-safe JSON data");
  }
  return values.flatMap((value) =>
    isRecord(value) && Array.isArray(value.resources) ? value.resources : [value],
  );
}

function isLegacyAsset(value: unknown): value is LegacyAsset {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["apiVersion", "labels", "name", "spec", "type"]) &&
    value.apiVersion === "v1" &&
    value.type === "Asset" &&
    typeof value.name === "string" &&
    /^[0-9a-f]{16}$/u.test(value.name) &&
    (value.labels === undefined ||
      (isRecord(value.labels) &&
        Object.values(value.labels).every((label) => typeof label === "string"))) &&
    isRecord(value.spec) &&
    hasOnlyKeys(value.spec, ["integrity", "mediaType", "uri"]) &&
    typeof value.spec.uri === "string" &&
    !value.spec.uri.startsWith("https://") &&
    typeof value.spec.integrity === "string" &&
    /^sha256-[A-Za-z0-9+/]{43}=$/u.test(value.spec.integrity) &&
    (value.spec.mediaType === undefined || typeof value.spec.mediaType === "string")
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === new Set(keys).size && keys.every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(source: Uint8Array | undefined, message: string): TopikAssetResult<T> {
  return {
    ok: false,
    diagnostics: [topikAssetDiagnostic("TOPIK_ASSET_MIGRATION_INVALID", message)],
    ...(source === undefined ? {} : { source }),
  };
}

function failure<T>(
  diagnostics: readonly TopikAssetDiagnostic[],
  source: Uint8Array | undefined,
): TopikAssetResult<T> {
  return {
    ok: false,
    diagnostics,
    ...(source === undefined ? {} : { source }),
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
