import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const STAGE_PREFIX = ".topik-sha256-stage-";
const PRIOR_PREFIX = ".topik-sha256-prior-";
const TARGET = "sha256";

export interface DigestSnapshotFile {
  bytes: Uint8Array;
  digest: string;
}

interface AnchoredDirectory {
  handle: FileHandle;
  path: string;
}

interface BoundDigestFile {
  digest: string;
  name: string;
  size: bigint;
}

interface OwnedDigestDirectory {
  files: readonly BoundDigestFile[];
  handle: FileHandle;
  name: string;
}

interface SnapshotFile extends DigestSnapshotFile {
  bytes: Uint8Array;
}

/** Publish one fully staged snapshot for cooperative callers. */
export async function publishDigestSnapshot(
  outputDirectory: URL,
  files: readonly DigestSnapshotFile[],
): Promise<void> {
  const snapshots = snapshotFiles(files);
  const assetsPath = resolve(fileURLToPath(outputDirectory), "assets");
  const parent = await openAnchoredDirectory(assetsPath, true);
  if (parent === undefined) throw publicationError("output parent could not be created safely");

  let prior: OwnedDigestDirectory | undefined;
  let stage: OwnedDigestDirectory | undefined;
  let priorRemoved = false;
  let stagePublished = false;
  let stageRemoved = false;
  let operationError: unknown;
  try {
    stage = await createStage(parent, snapshots);
    prior = await openOwnedTarget(parent);

    if (snapshots.length === 0) {
      if (prior !== undefined) {
        moveOwnedDirectory(parent, prior, `${PRIOR_PREFIX}${randomUUID()}`);
        cleanupOwnedDirectory(parent, prior);
        priorRemoved = true;
      }
      cleanupOwnedDirectory(parent, stage);
      stageRemoved = true;
    } else {
      if (prior !== undefined) moveOwnedDirectory(parent, prior, `${PRIOR_PREFIX}${randomUUID()}`);
      renameSync(ownedPath(parent, stage), procFdChild(parent.handle.fd, TARGET));
      stage.name = TARGET;
      stagePublished = true;

      if (prior !== undefined) {
        cleanupOwnedDirectory(parent, prior);
        priorRemoved = true;
      }
    }
  } catch (error) {
    operationError = error;
  }
  if (!stagePublished && !stageRemoved && stage !== undefined) {
    try {
      cleanupOwnedDirectory(parent, stage);
    } catch (error) {
      operationError ??= error;
    }
  }
  if (!priorRemoved && prior !== undefined && prior.name !== TARGET) {
    try {
      cleanupOwnedDirectory(parent, prior);
    } catch (error) {
      operationError ??= error;
    }
  }
  await stage?.handle.close().catch(() => undefined);
  await prior?.handle.close().catch(() => undefined);
  await parent.handle.close().catch(() => undefined);
  if (operationError !== undefined) throw operationError;
}

export async function removeDigestSnapshot(outputDirectory: URL): Promise<void> {
  const assetsPath = resolve(fileURLToPath(outputDirectory), "assets");
  const parent = await openAnchoredDirectory(assetsPath, false);
  if (parent === undefined) return;
  let prior: OwnedDigestDirectory | undefined;
  let removed = false;
  let operationError: unknown;
  try {
    prior = await openOwnedTarget(parent);
    if (prior !== undefined) {
      moveOwnedDirectory(parent, prior, `${PRIOR_PREFIX}${randomUUID()}`);
      cleanupOwnedDirectory(parent, prior);
      removed = true;
    }
  } catch (error) {
    operationError = error;
  }
  if (!removed && prior !== undefined && prior.name !== TARGET) {
    try {
      cleanupOwnedDirectory(parent, prior);
    } catch (error) {
      operationError ??= error;
    }
  }
  await prior?.handle.close().catch(() => undefined);
  await parent.handle.close().catch(() => undefined);
  if (operationError !== undefined) throw operationError;
}

async function createStage(
  parent: AnchoredDirectory,
  files: readonly SnapshotFile[],
): Promise<OwnedDigestDirectory> {
  const path = await mkdtemp(procFdChild(parent.handle.fd, STAGE_PREFIX));
  const name = basename(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      procFdChild(parent.handle.fd, name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw publicationError("staging identity is invalid");
    for (const file of files) {
      let output: FileHandle | undefined;
      try {
        output = await open(
          procFdChild(handle.fd, file.digest),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o400,
        );
        await output.writeFile(file.bytes);
        await output.chmod(0o444);
      } finally {
        await output?.close().catch(() => undefined);
      }
    }
    const tree = bindDigestTreeSync(handle);
    assertExpectedTree(tree, files);
    return { files: tree, handle, name };
  } catch (error) {
    cleanupPartialStage(parent, handle, name);
    await handle?.close().catch(() => undefined);
    if (error instanceof TypeError) throw error;
    throw publicationError("staging could not be created safely");
  }
}

function cleanupPartialStage(
  parent: AnchoredDirectory,
  handle: FileHandle | undefined,
  name: string,
): void {
  try {
    if (handle !== undefined) {
      for (const entry of readdirSync(procFd(handle.fd), { withFileTypes: true })) {
        if (!entry.isFile() || !DIGEST_PATTERN.test(entry.name)) return;
        unlinkSync(procFdChild(handle.fd, entry.name));
      }
    }
    rmdirSync(procFdChild(parent.handle.fd, name));
  } catch {
    // The original staging failure remains the actionable error.
  }
}

async function openOwnedTarget(
  parent: AnchoredDirectory,
): Promise<OwnedDigestDirectory | undefined> {
  const path = procFdChild(parent.handle.fd, TARGET);
  let visible: BigIntStats;
  try {
    visible = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw publicationError("output target could not be inspected safely");
  }
  if (!visible.isDirectory()) {
    throw publicationError("output target contains a link or non-directory collision");
  }
  const handle = await openChildDirectory(parent.handle, TARGET, false);
  if (handle === undefined) throw publicationError("output target identity could not be opened");
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isDirectory() || actual.dev !== visible.dev || actual.ino !== visible.ino) {
      throw publicationError("output target identity is inconsistent");
    }
    return { files: bindDigestTreeSync(handle), handle, name: TARGET };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof TypeError) throw error;
    throw publicationError("output target contents are unsafe");
  }
}

function moveOwnedDirectory(
  parent: AnchoredDirectory,
  owned: OwnedDigestDirectory,
  destinationName: string,
): void {
  assertPathAbsent(procFdChild(parent.handle.fd, destinationName));
  renameSync(ownedPath(parent, owned), procFdChild(parent.handle.fd, destinationName));
  owned.name = destinationName;
}

function cleanupOwnedDirectory(parent: AnchoredDirectory, owned: OwnedDigestDirectory): void {
  for (const file of owned.files) unlinkSync(procFdChild(owned.handle.fd, file.name));
  if (readdirSync(procFd(owned.handle.fd)).length !== 0) {
    throw publicationError("cleanup found an unexpected output entry");
  }
  rmdirSync(ownedPath(parent, owned));
}

function bindDigestTreeSync(directory: FileHandle): readonly BoundDigestFile[] {
  try {
    return readdirSync(procFd(directory.fd), { withFileTypes: true })
      .map((entry) => entry.name)
      .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
      .map((name) => bindDigestFileSync(directory, name));
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw publicationError("output snapshot contents are unsafe");
  }
}

function bindDigestFileSync(directory: FileHandle, name: string): BoundDigestFile {
  if (!DIGEST_PATTERN.test(name)) {
    throw publicationError("output snapshot contains a non-canonical entry");
  }
  const path = procFdChild(directory.fd, name);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
    );
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw publicationError("output snapshot contains an unsafe file entry");
    }
    const pathStat = lstatSync(path, { bigint: true });
    if (!pathStat.isFile() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      throw publicationError("output snapshot file binding is inconsistent");
    }
    const digest = sha256(readFileSync(fd));
    if (digest !== name) {
      throw publicationError("output snapshot digest does not match its bytes");
    }
    return { digest, name, size: stat.size };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertExpectedTree(
  tree: readonly BoundDigestFile[],
  files: readonly SnapshotFile[],
): void {
  if (tree.length !== files.length) {
    throw publicationError("staged output contains an unexpected entry");
  }
  const expected = new Map(files.map((file) => [file.digest, file] as const));
  for (const actual of tree) {
    const file = expected.get(actual.name);
    if (
      file === undefined ||
      actual.digest !== file.digest ||
      actual.size !== BigInt(file.bytes.byteLength)
    ) {
      throw publicationError("staged output bytes do not match the compiler snapshot");
    }
  }
}

function assertPathAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw publicationError("replacement storage could not be inspected safely");
  }
  throw publicationError("replacement storage is already occupied");
}

async function openAnchoredDirectory(
  absolutePath: string,
  create: boolean,
): Promise<AnchoredDirectory | undefined> {
  if (
    process.platform !== "linux" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw publicationError("platform cannot provide descriptor-anchored output containment");
  }
  const normalized = resolve(absolutePath);
  if (normalized === "/") throw publicationError("output parent cannot be the filesystem root");
  const components = normalized.split("/").filter(Boolean);
  let current = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const child = await openChildDirectory(current, component, create);
      if (child === undefined) {
        await current.close();
        return undefined;
      }
      await current.close();
      current = child;
    }
    return { handle: current, path: normalized };
  } catch (error) {
    await current.close().catch(() => undefined);
    if (error instanceof TypeError) throw error;
    throw publicationError("output has an unsafe or unresolvable ancestor");
  }
}

async function openChildDirectory(
  parent: FileHandle,
  name: string,
  create: boolean,
): Promise<FileHandle | undefined> {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/")) {
    throw publicationError("output path is invalid");
  }
  const path = procFdChild(parent.fd, name);
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw publicationError("output contains a link or non-directory ancestor");
    }
    await mkdir(path, { mode: 0o700 }).catch((mkdirError) => {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    });
    try {
      return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      throw publicationError("output directory could not be opened safely");
    }
  }
}

function snapshotFiles(files: readonly DigestSnapshotFile[]): readonly SnapshotFile[] {
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

function ownedPath(parent: AnchoredDirectory, owned: OwnedDigestDirectory): string {
  return procFdChild(parent.handle.fd, owned.name);
}

function procFd(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function procFdChild(fd: number, name: string): string {
  return `${procFd(fd)}/${name}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicationError(reason: string): TypeError {
  return new TypeError(`Topik Asset ${reason}`);
}
