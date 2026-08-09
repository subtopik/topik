import { createHash } from "node:crypto";
import {
  extractTopikAssetOccurrences,
  rewriteTopikAssetOccurrences,
  type TopikAssetOccurrence,
} from "@topik/content-schema";
import type { Asset } from "@topik/schema";
import type { Resource } from "../resource";
import { validateResources } from "../validate";
import { generateImplicitAssetName, validateStableSourceNamespace } from "./asset";
import { topikAssetDiagnostic, type TopikAssetResult } from "./diagnostics";
import { readPortableAssetFile } from "./files";
import { parseStrictTopikJson } from "./json";
import { isTopikActiveMediaType, sniffPortableMediaType } from "./media";
import { validateTopikPathSet } from "./path";

export interface MigrateLegacyDigestOutputOptions {
  rootDir: string;
  stableSourceNamespace: string;
}

export interface LegacyDigestMigrationResult {
  resources: Resource[];
  /** Exact caller bytes. Store this before replacing legacy output. */
  backup: Uint8Array;
}

interface LegacyAsset {
  apiVersion: "v1";
  type: "Asset";
  name: string;
  labels?: Record<string, string>;
  spec: { uri: string; integrity: string; mediaType?: string };
}

/** Migrate the public 16-hex digest output without accepting partial or remote sets. */
export async function migrateLegacyDigestOutput(
  input: string | Uint8Array,
  options: MigrateLegacyDigestOutputOptions,
): Promise<TopikAssetResult<LegacyDigestMigrationResult>> {
  const backup =
    typeof input === "string" ? new TextEncoder().encode(input) : Uint8Array.from(input);
  let value: unknown;
  try {
    value = parseStrictTopikJson(new TextDecoder("utf-8", { fatal: true }).decode(backup), 12);
  } catch {
    return invalid(backup, "Legacy input is not strict UTF-8 JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.resources)) {
    return invalid(backup, "Legacy input must be an object containing resources");
  }
  const namespace = validateStableSourceNamespace(options.stableSourceNamespace);
  if (!namespace.ok) {
    return { ok: false, diagnostics: namespace.diagnostics, source: backup };
  }

  const legacyAssets = value.resources.filter(isLegacyAsset);
  if (
    legacyAssets.length !==
    value.resources.filter((entry) => isRecord(entry) && entry.type === "Asset").length
  ) {
    return invalid(backup, "Legacy Asset set is malformed or uses unsupported remote input");
  }
  const paths = legacyAssets.map((asset) => asset.spec.uri);
  const pathSet = validateTopikPathSet(paths);
  if (!pathSet.ok) return { ok: false, diagnostics: pathSet.diagnostics, source: backup };
  const oldNames = new Set<string>();
  const newNames = new Set<string>();
  const nameMap = new Map<string, string>();
  const migratedAssets: Asset[] = [];
  const allReferenced = new Set<string>();

  for (const legacy of legacyAssets) {
    if (oldNames.has(legacy.name)) return invalid(backup, "Legacy Asset name is duplicated");
    oldNames.add(legacy.name);
    const generated = generateImplicitAssetName({
      stableSourceNamespace: namespace.value,
      normalizedPath: legacy.spec.uri,
    });
    if (!generated.ok) return { ok: false, diagnostics: generated.diagnostics, source: backup };
    if (newNames.has(generated.value)) return invalid(backup, "Migrated Asset name collides");
    newNames.add(generated.value);
    nameMap.set(legacy.name, generated.value);
    const read = await readPortableAssetFile({ root: options.rootDir, path: legacy.spec.uri });
    if (!read.ok || read.value.bytes === undefined) {
      return { ok: false, diagnostics: read.diagnostics, source: backup };
    }
    const digest = createHash("sha256").update(read.value.bytes).digest();
    if (legacy.name !== digest.toString("hex").slice(0, 16)) {
      return invalid(backup, "Legacy Asset name does not match its digest-prefix identity");
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
        source: backup,
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
        source: backup,
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
  for (const entry of value.resources) {
    if (isLegacyAsset(entry)) continue;
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.name !== "string") {
      return invalid(backup, "Legacy resource set contains a malformed resource");
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
      return invalid(backup, "Legacy content resource is malformed");
    }
    if (
      entry.spec.assets !== undefined &&
      (!Array.isArray(entry.spec.assets) ||
        entry.spec.assets.some((name) => typeof name !== "string" || !oldNames.has(name)))
    ) {
      return invalid(backup, "Legacy content resource has a malformed or partial Asset list");
    }
    if (entry.spec.assets === undefined) {
      const occurrences = extractTopikAssetOccurrences(entry.spec.content.value, {
        includeGenericLinkCandidates: true,
      });
      if (occurrences.some(isUnmigratableUnsafeOccurrence)) {
        return invalid(backup, "Legacy content contains an unsafe Asset-capable reference");
      }
      if (
        occurrences.some(
          (occurrence) =>
            occurrence.kind === "asset" ||
            occurrence.reference.startsWith("asset:") ||
            occurrence.parsedReference.startsWith("asset:"),
        )
      ) {
        return invalid(backup, "Legacy content references an Asset without an Asset list");
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
      return invalid(backup, "Legacy content contains an unresolved Asset reference");
    }
    if (legacyAssetList.some((name) => !referenced.has(name))) {
      return invalid(backup, "Legacy Asset list is ambiguous or contains an unused entry");
    }
    if ([...referenced].some((name) => !legacyAssetList.includes(name))) {
      return invalid(backup, "Legacy content references an Asset absent from its Asset list");
    }
    const spec: Record<string, unknown> = {
      ...entry.spec,
      content: { ...entry.spec.content, value: content },
    };
    delete spec.assets;
    migratedResources.push({ ...entry, spec } as Resource);
  }

  if (legacyAssets.some((asset) => !allReferenced.has(asset.name))) {
    return invalid(backup, "Legacy Asset set is partial or ambiguous");
  }

  const resources = [...migratedResources, ...migratedAssets].sort((left, right) =>
    compareUtf8(`${left.type}/${left.name}`, `${right.type}/${right.name}`),
  );
  if (!validateResources(resources).valid) {
    return invalid(backup, "Migrated resource set is invalid");
  }
  return { ok: true, value: { resources, backup }, diagnostics: [], source: backup };
}

function isUnmigratableUnsafeOccurrence(occurrence: TopikAssetOccurrence): boolean {
  return (
    occurrence.kind === "unsafe" &&
    (occurrence.slot !== "link.href" ||
      occurrence.reference.startsWith("asset:") ||
      occurrence.parsedReference.startsWith("asset:"))
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

function invalid<T>(source: Uint8Array, message: string): TopikAssetResult<T> {
  return {
    ok: false,
    diagnostics: [topikAssetDiagnostic("TOPIK_ASSET_MIGRATION_INVALID", message)],
    source,
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
