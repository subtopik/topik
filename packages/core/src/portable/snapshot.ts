import { createHash } from "node:crypto";
import { extractTopikAssetOccurrences, type TopikAssetOccurrence } from "@topik/content-schema";
import type {
  AssetManifestEntryV1,
  AssetManifestResourceBindingV1,
  AssetManifestV1,
} from "@topik/schema";
import { TOPIK_ASSET_REFERENCE_VERSION } from "./constants";
import {
  relocateTopikAssetDiagnostic,
  topikAssetDiagnostic,
  type TopikAssetDiagnostic,
  type TopikAssetResult,
} from "./diagnostics";
import { validatePortableAssetFile, type PortableAssetFileDescriptor } from "./files";
import { validateAssetManifestValue } from "./manifest";
import { decodeTopikAssetReference, validateTopikExternalAssetReference } from "./reference";

export interface PortableAssetContentSource {
  path: string;
  source: string;
  downloadableLinkPositions?: readonly string[];
}

export interface ValidatePortableAssetSnapshotInput {
  manifest: unknown;
  resource: AssetManifestResourceBindingV1;
  contents: readonly PortableAssetContentSource[];
  files: readonly PortableAssetFileDescriptor[];
  /** Active bytes are otherwise rejected even for downloads. */
  allowActiveDownloads?: boolean;
}

export interface ResolvedTopikAssetOccurrence extends TopikAssetOccurrence {
  contentPath: string;
  assetKey?: string;
  decodedPath?: string;
}

export interface ValidatedPortableAssetFile {
  key: string;
  descriptor: PortableAssetFileDescriptor & { bytes: Uint8Array };
  verifiedMediaType: string;
  digest: string;
}

export interface ValidatedPortableAssetSnapshot {
  manifest: AssetManifestV1;
  resource: AssetManifestResourceBindingV1;
  occurrences: readonly ResolvedTopikAssetOccurrence[];
  files: readonly ValidatedPortableAssetFile[];
}

export function validatePortableAssetSnapshot(
  input: ValidatePortableAssetSnapshotInput,
): TopikAssetResult<ValidatedPortableAssetSnapshot> {
  const manifestValidation = validateAssetManifestValue(input.manifest);
  if (!manifestValidation.ok) {
    return { ok: false, diagnostics: manifestValidation.diagnostics };
  }
  const manifest = manifestValidation.value;
  const diagnostics: TopikAssetDiagnostic[] = [];

  if (!sameResource(manifest.resource, input.resource)) {
    diagnostics.push(
      topikAssetDiagnostic(
        "TOPIK_ASSET_RESOURCE_MISMATCH",
        "Manifest resource tuple does not match",
        {
          location: { jsonPointer: "/resource", path: manifest.resource.path },
        },
      ),
    );
  }

  const entriesByPath = new Map<string, Array<[string, AssetManifestEntryV1]>>();
  for (const pair of Object.entries(manifest.assets)) {
    const list = entriesByPath.get(pair[1].path) ?? [];
    list.push(pair);
    entriesByPath.set(pair[1].path, list);
  }

  const occurrences: ResolvedTopikAssetOccurrence[] = [];
  const referencedKeys = new Set<string>();
  const manifestPaths = new Set(entriesByPath.keys());
  for (const content of input.contents) {
    const extracted = extractTopikAssetOccurrences(content.source, {
      manifestPaths,
      downloadableLinkPositions: content.downloadableLinkPositions,
    });
    for (const occurrence of extracted) {
      const resolved: ResolvedTopikAssetOccurrence = { ...occurrence, contentPath: content.path };
      occurrences.push(resolved);
      if (!hasAccessibleMeaning(occurrence)) {
        diagnostics.push(
          topikAssetDiagnostic(
            "TOPIK_ASSET_REFERENCE_ACCESSIBILITY_INVALID",
            "Occurrence lacks schema-supported accessible meaning",
            {
              location: {
                contentPosition: occurrence.position,
                path: safe(occurrence.reference),
              },
            },
          ),
        );
      }
      if (occurrence.kind === "external-https") {
        const external = validateTopikExternalAssetReference(occurrence.reference);
        if (!external.ok)
          diagnostics.push(...atOccurrence(external.diagnostics, content.path, occurrence));
        continue;
      }
      if (occurrence.kind === "unsafe") {
        diagnostics.push(
          topikAssetDiagnostic(
            "TOPIK_EXTERNAL_REFERENCE_UNSAFE",
            "Unsafe reference in asset slot",
            {
              descriptorVersion: TOPIK_ASSET_REFERENCE_VERSION,
              location: {
                contentPosition: occurrence.position,
                path: safe(occurrence.reference),
              },
              recovery: "preserve-read-only",
            },
          ),
        );
        continue;
      }
      const decoded = decodeTopikAssetReference(occurrence.reference);
      if (!decoded.ok) {
        diagnostics.push(...atOccurrence(decoded.diagnostics, content.path, occurrence));
        continue;
      }
      resolved.decodedPath = decoded.value;
      const candidates = entriesByPath.get(decoded.value) ?? [];
      if (candidates.length === 0) {
        diagnostics.push(
          topikAssetDiagnostic(
            "TOPIK_ASSET_MANIFEST_INCOMPLETE",
            "Local occurrence has no manifest entry",
            {
              location: { contentPosition: occurrence.position, path: decoded.value },
            },
          ),
        );
        continue;
      }
      if (candidates.length !== 1) {
        diagnostics.push(
          topikAssetDiagnostic(
            "TOPIK_ASSET_REFERENCE_AMBIGUOUS",
            "Occurrence resolves to several entries",
            {
              location: { contentPosition: occurrence.position, path: decoded.value },
            },
          ),
        );
        continue;
      }
      resolved.assetKey = candidates[0][0];
      referencedKeys.add(candidates[0][0]);
    }
  }

  for (const [key, entry] of Object.entries(manifest.assets)) {
    if (!referencedKeys.has(key)) {
      diagnostics.push(
        topikAssetDiagnostic(
          "TOPIK_ASSET_ENTRY_UNREFERENCED",
          "Manifest entry has no declared occurrence",
          {
            location: { jsonPointer: `/assets/${escapePointer(key)}`, key, path: entry.path },
          },
        ),
      );
    }
  }

  const filesByPath = new Map<string, PortableAssetFileDescriptor[]>();
  for (const file of input.files) {
    const list = filesByPath.get(file.path) ?? [];
    list.push(file);
    filesByPath.set(file.path, list);
  }
  const verifiedFiles: ValidatedPortableAssetFile[] = [];
  for (const [key, entry] of Object.entries(manifest.assets)) {
    const files = filesByPath.get(entry.path) ?? [];
    if (files.length === 0) {
      diagnostics.push(
        topikAssetDiagnostic("TOPIK_ASSET_FILE_MISSING", "Manifest entry file is missing", {
          location: { key, path: entry.path },
          recovery: "restore-file",
        }),
      );
      continue;
    }
    if (files.length !== 1) {
      diagnostics.push(
        topikAssetDiagnostic(
          "TOPIK_ASSET_REFERENCE_AMBIGUOUS",
          "Several file descriptors claim one path",
          {
            location: { key, path: entry.path },
          },
        ),
      );
      continue;
    }
    const fileValidation = validatePortableAssetFile(files[0]);
    if (!fileValidation.ok || fileValidation.value?.bytes === undefined) {
      diagnostics.push(...fileValidation.diagnostics);
      continue;
    }
    const descriptor = fileValidation.value as PortableAssetFileDescriptor & { bytes: Uint8Array };
    const digest = createHash("sha256").update(descriptor.bytes).digest("hex");
    const mediaType = sniffPortableMediaType(descriptor.bytes);
    if (digest !== entry.digest.value) {
      diagnostics.push(
        topikAssetDiagnostic("TOPIK_ASSET_DIGEST_MISMATCH", "Verified SHA-256 differs", {
          location: { key, path: entry.path },
          recovery: "verify-bytes",
        }),
      );
    }
    if (descriptor.bytes.byteLength !== entry.size) {
      diagnostics.push(
        topikAssetDiagnostic("TOPIK_ASSET_SIZE_MISMATCH", "Verified byte length differs", {
          location: { key, path: entry.path },
          recovery: "verify-bytes",
        }),
      );
    }
    if (mediaType !== entry.mediaType) {
      diagnostics.push(
        topikAssetDiagnostic("TOPIK_ASSET_MEDIA_TYPE_MISMATCH", "Verified media type differs", {
          location: { key, path: entry.path },
          recovery: "verify-bytes",
        }),
      );
    }

    const entryOccurrences = occurrences.filter((occurrence) => occurrence.assetKey === key);
    for (const occurrence of entryOccurrences) {
      const inline = occurrence.role !== "download";
      if (
        (inline && !isInlineMediaCompatible(mediaType, occurrence.role)) ||
        isActiveType(mediaType)
      ) {
        if (!(occurrence.role === "download" && input.allowActiveDownloads === true)) {
          diagnostics.push(
            topikAssetDiagnostic(
              "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED",
              "Verified media type is incompatible with the occurrence role",
              { location: { key, path: entry.path, contentPosition: occurrence.position } },
            ),
          );
        }
      }
    }
    verifiedFiles.push({ key, descriptor, verifiedMediaType: mediaType, digest });
  }

  const value = { manifest, resource: input.resource, occurrences, files: verifiedFiles };
  return diagnostics.length === 0
    ? { ok: true, value, diagnostics: [] }
    : { ok: false, value, diagnostics };
}

export function sniffPortableMediaType(bytes: Uint8Array): string {
  const has = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (has(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (has(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 8).includes("ftypavif")) return "image/avif";
  if (ascii(bytes, 0, 2) === "BM") return "image/bmp";
  if (has(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (has(0x50, 0x4b, 0x03, 0x04) || has(0x50, 0x4b, 0x05, 0x06)) return "application/zip";
  if (has(0x1f, 0x8b)) return "application/gzip";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  if (ascii(bytes, 4, 4) === "ftyp") return "video/mp4";
  const text = safeText(bytes.slice(0, 4096)).trimStart().toLowerCase();
  if (/^(?:<!doctype\s+html|<html\b)/u.test(text)) return "text/html";
  if (/^<\?xml[^>]*>\s*<svg\b/u.test(text) || /^<svg\b/u.test(text)) return "image/svg+xml";
  return "application/octet-stream";
}

function sameResource(
  left: AssetManifestResourceBindingV1,
  right: AssetManifestResourceBindingV1,
): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.type === right.type &&
    left.name === right.name &&
    left.path === right.path
  );
}

function hasAccessibleMeaning(occurrence: TopikAssetOccurrence): boolean {
  if (occurrence.role === "download")
    return (occurrence.semantics.linkLabel?.trim().length ?? 0) > 0;
  if (occurrence.slot.startsWith("figure."))
    return (occurrence.semantics.alt?.trim().length ?? 0) > 0;
  return (
    occurrence.semantics.decorative === true || (occurrence.semantics.alt?.trim().length ?? 0) > 0
  );
}

function isInlineMediaCompatible(mediaType: string, role: TopikAssetOccurrence["role"]): boolean {
  return role.startsWith("image")
    ? mediaType.startsWith("image/")
    : /^(?:image|audio|video)\//u.test(mediaType);
}

function isActiveType(mediaType: string): boolean {
  return ["text/html", "image/svg+xml", "application/javascript", "text/javascript"].includes(
    mediaType,
  );
}

function atOccurrence(
  diagnostics: readonly TopikAssetDiagnostic[],
  contentPath: string,
  occurrence: TopikAssetOccurrence,
): TopikAssetDiagnostic[] {
  return diagnostics.map((diagnostic) =>
    relocateTopikAssetDiagnostic(diagnostic, {
      ...diagnostic.location,
      path: contentPath,
      contentPosition: occurrence.position,
    }),
  );
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function safeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function safe(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
