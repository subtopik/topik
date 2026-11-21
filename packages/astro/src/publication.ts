import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FILE_SAFETY,
  OutputPublicationError,
  publishOutputDirectory,
  removeOutputDirectory,
  type FileSafety,
  type OutputPublicationErrorReason,
  type OwnedOutputEntry,
} from "@topik/core";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const STAGE_PREFIX = ".topik-blobs-stage-";
const PRIOR_PREFIX = ".topik-blobs-prior-";
const TARGET = "blobs";
/** Content-addressed payloads never change once published. */
const PUBLISHED_FILE_MODE = 0o444;

export interface DigestSnapshotFile {
  bytes: Uint8Array;
  digest: string;
}

/**
 * Publish one fully staged snapshot for cooperative callers. Linux always publishes through
 * descriptor-anchored directories; elsewhere `fileSafety` `"portable"` (the default) checks
 * paths and file identity instead, and `"anchored"` refuses the platform.
 */
export async function publishDigestSnapshot(
  outputDirectory: URL,
  files: readonly DigestSnapshotFile[],
  fileSafety: FileSafety = DEFAULT_FILE_SAFETY,
): Promise<void> {
  const snapshots = snapshotFiles(files);
  const outputPath = resolve(fileURLToPath(outputDirectory));
  if (snapshots.length === 0) {
    // Nothing to publish: remove a previous snapshot instead of publishing an empty one.
    await removeDigestSnapshot(outputDirectory, fileSafety);
    return;
  }
  const { priorRetained } = await publishOutputDirectory(
    join(outputPath, TARGET),
    snapshots.map((file) => ({ path: file.digest, bytes: file.bytes })),
    {
      fileSafety,
      generationPrefix: STAGE_PREFIX,
      priorPrefix: PRIOR_PREFIX,
      directories: [],
      fileMode: PUBLISHED_FILE_MODE,
      isOwned: isOwnedDigestTree,
      // A retained backup inside the build output would be deployed with the site.
      removePriorOnFailure: true,
    },
  ).catch((error: unknown) => {
    throw toAssetPublicationError(error);
  });
  // A retained backup inside the build output would be deployed with the site.
  if (priorRetained) throw publicationError("previous asset output could not be removed");
}

export async function removeDigestSnapshot(
  outputDirectory: URL,
  fileSafety: FileSafety = DEFAULT_FILE_SAFETY,
): Promise<void> {
  const outputPath = resolve(fileURLToPath(outputDirectory));
  // A site without Assets builds anywhere, even when anchored publication is unavailable.
  if (requiresUnavailableAnchoring(fileSafety) && (await targetAbsent(outputPath))) return;
  await removeOutputDirectory(join(outputPath, TARGET), {
    fileSafety,
    priorPrefix: PRIOR_PREFIX,
    isOwned: isOwnedDigestTree,
  }).catch((error: unknown) => {
    throw toAssetPublicationError(error);
  });
}

/** A previous snapshot holds only single-link files named by the SHA-256 of their bytes. */
function isOwnedDigestTree(entries: readonly OwnedOutputEntry[]): boolean {
  return entries.every((entry) =>
    entry.path === ""
      ? entry.kind === "directory"
      : entry.kind === "file" && DIGEST_PATTERN.test(entry.path) && entry.digest === entry.path,
  );
}

function requiresUnavailableAnchoring(fileSafety: FileSafety): boolean {
  return process.platform !== "linux" && fileSafety === "anchored";
}

/** Path-based absence probe used only where nothing will be written or removed. */
async function targetAbsent(outputPath: string): Promise<boolean> {
  try {
    await lstat(join(outputPath, TARGET));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw publicationError("output target could not be inspected safely");
  }
  return false;
}

const ASSET_PUBLICATION_MESSAGES: Readonly<Record<OutputPublicationErrorReason, string>> = {
  "target-collision": "output target contains a link or non-directory collision",
  "ancestor-collision": "output contains a link or non-directory ancestor",
  "not-owned": "output target contents are unsafe: it is not a previous digest snapshot",
  "ancestor-unsafe": "output has an unsafe or unresolvable ancestor",
  "platform-unsupported":
    "publication requires Linux: this platform cannot provide descriptor-anchored output containment",
  "publication-failed": "publication failed after moving the previous snapshot aside",
};

/** Present core's fixed publication failures with this integration's wording. */
function toAssetPublicationError(error: unknown): unknown {
  if (!(error instanceof OutputPublicationError)) return error;
  return error.reason === undefined
    ? publicationError(`output is unsafe: ${error.message}`)
    : publicationError(ASSET_PUBLICATION_MESSAGES[error.reason]);
}

function snapshotFiles(files: readonly DigestSnapshotFile[]): readonly DigestSnapshotFile[] {
  const digests = new Set<string>();
  return files.map((file) => {
    if (!DIGEST_PATTERN.test(file.digest) || digests.has(file.digest)) {
      throw publicationError("compiler snapshot contains a non-canonical or repeated digest");
    }
    digests.add(file.digest);
    const bytes = Uint8Array.from(file.bytes);
    if (sha256(bytes) !== file.digest) {
      throw publicationError("compiler snapshot digest does not match its bytes");
    }
    return { bytes, digest: file.digest };
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicationError(reason: string): TypeError {
  return new TypeError(`Topik Asset ${reason}`);
}
