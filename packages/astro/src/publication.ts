import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
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
const HIDDEN_PREFIX = ".topik-sha256-hidden-";
const TARGET = "sha256";

export interface DigestSnapshotFile {
  bytes: Uint8Array;
  digest: string;
}

/** Internal deterministic seams used to prove publication race behavior. */
export interface DigestSnapshotPublicationTestHooks {
  afterCleanupFileProof?: (
    path: string,
    kind: "prior" | "removed" | "stage",
  ) => void | Promise<void>;
  afterCleanupProof?: (path: string, kind: "prior" | "removed" | "stage") => void | Promise<void>;
  afterHiddenProof?: (path: string, phase: "publish" | "remove") => void | Promise<void>;
  afterParentProof?: (path: string, phase: "publish" | "remove") => void | Promise<void>;
  afterPriorProof?: (path: string, phase: "publish" | "remove") => void | Promise<void>;
  afterReservedProof?: (
    path: string,
    purpose: "backup" | "publish" | "remove" | "restore",
  ) => void | Promise<void>;
  afterRestoreProof?: (path: string) => void | Promise<void>;
  afterStageProof?: (path: string) => void | Promise<void>;
  afterTargetProof?: (path: string, phase: "publish" | "remove") => void | Promise<void>;
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

interface CallerVisibleDirectoryBinding {
  identity: DirectoryIdentity;
  path: string;
}

interface AnchoredDirectory {
  bindings: readonly CallerVisibleDirectoryBinding[];
  handle: FileHandle;
  path: string;
}

interface StoredIdentity {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  size: bigint;
}

interface BoundDigestFile {
  digest: string;
  identity: StoredIdentity;
  name: string;
}

interface BoundDigestTree {
  identity: StoredIdentity;
  files: readonly BoundDigestFile[];
}

interface OwnedDigestDirectory {
  handle: FileHandle;
  identity: DirectoryIdentity;
  name: string;
  tree: BoundDigestTree;
}

interface ReservedDirectory {
  active: boolean;
  fd: number;
  identity: DirectoryIdentity;
  name: string;
}

interface SnapshotFile extends DigestSnapshotFile {
  bytes: Uint8Array;
}

export async function publishDigestSnapshot(
  outputDirectory: URL,
  files: readonly DigestSnapshotFile[],
  hooks: DigestSnapshotPublicationTestHooks = {},
): Promise<void> {
  const snapshots = snapshotFiles(files);
  const assetsPath = resolve(fileURLToPath(outputDirectory), "assets");
  const parent = await openAnchoredDirectory(assetsPath, true);
  if (parent === undefined) throw publicationError("output parent could not be created safely");

  let prior: OwnedDigestDirectory | undefined;
  let stage: OwnedDigestDirectory | undefined;
  let targetReservation: ReservedDirectory | undefined;
  let backupReservation: ReservedDirectory | undefined;
  let operationError: unknown;
  let committed = false;
  try {
    await hooks.afterParentProof?.(parent.path, "publish");
    stage = await createStage(parent, snapshots);
    await hooks.afterStageProof?.(ownedPath(parent, stage));
    prior = await openOwnedTarget(parent);
    if (prior !== undefined) {
      await hooks.afterPriorProof?.(ownedPath(parent, prior), "publish");
    }

    if (snapshots.length === 0) {
      if (prior !== undefined) {
        await hideOwnedDirectory(parent, prior, hooks, "publish");
        await cleanupOwnedDirectory(parent, prior, hooks, "removed");
      }
      await cleanupOwnedDirectory(parent, stage, hooks, "stage");
      await stage.handle.close();
      stage = undefined;
      return;
    }

    if (prior !== undefined) {
      backupReservation = reserveUniqueDirectory(parent, HIDDEN_PREFIX);
      await hooks.afterReservedProof?.(reservedPath(parent, backupReservation), "backup");
      await hooks.afterTargetProof?.(procFdChild(parent.handle.fd, TARGET), "publish");
      replaceOwnedWithReservationSync(parent, prior, backupReservation, parent.bindings);
      await hooks.afterHiddenProof?.(ownedPath(parent, prior), "publish");
    } else {
      await hooks.afterTargetProof?.(procFdChild(parent.handle.fd, TARGET), "publish");
    }

    targetReservation = reserveNamedDirectory(parent, TARGET);
    await hooks.afterReservedProof?.(reservedPath(parent, targetReservation), "publish");
    replaceOwnedWithReservationSync(parent, stage, targetReservation, parent.bindings, prior);
    committed = true;
    await parent.handle.sync();

    if (prior !== undefined) {
      await cleanupOwnedDirectory(parent, prior, hooks, "prior");
    }
  } catch (error) {
    operationError = error;
    if (!committed && prior !== undefined && prior.name !== TARGET) {
      try {
        targetReservation = await restoreOwnedTarget(parent, prior, targetReservation, hooks);
      } catch {
        // A newcomer or displaced binding is preserved; the proven prior remains hidden.
      }
    }
  } finally {
    if (!committed && stage !== undefined && stage.name !== TARGET) {
      await cleanupOwnedDirectory(parent, stage, hooks, "stage").catch(() => undefined);
    }
    releaseReservationSync(parent, targetReservation);
    releaseReservationSync(parent, backupReservation);
    closeReservation(targetReservation);
    closeReservation(backupReservation);
    await stage?.handle.close().catch(() => undefined);
    await prior?.handle.close().catch(() => undefined);
    await parent.handle.close().catch(() => undefined);
  }
  if (operationError !== undefined) throw operationError;
}

export async function removeDigestSnapshot(
  outputDirectory: URL,
  hooks: DigestSnapshotPublicationTestHooks = {},
): Promise<void> {
  const assetsPath = resolve(fileURLToPath(outputDirectory), "assets");
  const parent = await openAnchoredDirectory(assetsPath, false);
  if (parent === undefined) return;
  let prior: OwnedDigestDirectory | undefined;
  try {
    await hooks.afterParentProof?.(parent.path, "remove");
    prior = await openOwnedTarget(parent);
    if (prior === undefined) return;
    await hooks.afterPriorProof?.(ownedPath(parent, prior), "remove");
    await hideOwnedDirectory(parent, prior, hooks, "remove");
    await cleanupOwnedDirectory(parent, prior, hooks, "removed");
    await parent.handle.sync();
  } finally {
    await prior?.handle.close().catch(() => undefined);
    await parent.handle.close().catch(() => undefined);
  }
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
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory()) throw publicationError("staging identity is invalid");
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
        await output.sync();
      } finally {
        await output?.close().catch(() => undefined);
      }
    }
    await handle.sync();
    const tree = bindDigestTreeSync(handle);
    assertExpectedTree(tree, files);
    return {
      handle,
      identity: { dev: identity.dev, ino: identity.ino },
      name,
      tree,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof TypeError) throw error;
    throw publicationError("staging could not be created safely");
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
  if (handle === undefined) throw publicationError("output target identity could not be proven");
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isDirectory() || actual.dev !== visible.dev || actual.ino !== visible.ino) {
      throw publicationError("output target identity changed during inspection");
    }
    return {
      handle,
      identity: { dev: actual.dev, ino: actual.ino },
      name: TARGET,
      tree: bindDigestTreeSync(handle),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof TypeError) throw error;
    throw publicationError("output target contents could not be proven safely");
  }
}

async function hideOwnedDirectory(
  parent: AnchoredDirectory,
  owned: OwnedDigestDirectory,
  hooks: DigestSnapshotPublicationTestHooks,
  phase: "publish" | "remove",
): Promise<void> {
  const reservation = reserveUniqueDirectory(parent, HIDDEN_PREFIX);
  try {
    await hooks.afterReservedProof?.(
      reservedPath(parent, reservation),
      phase === "remove" ? "remove" : "backup",
    );
    await hooks.afterTargetProof?.(ownedPath(parent, owned), phase);
    replaceOwnedWithReservationSync(parent, owned, reservation, parent.bindings);
    await hooks.afterHiddenProof?.(ownedPath(parent, owned), phase);
  } finally {
    releaseReservationSync(parent, reservation);
    closeReservation(reservation);
  }
}

async function restoreOwnedTarget(
  parent: AnchoredDirectory,
  prior: OwnedDigestDirectory,
  currentReservation: ReservedDirectory | undefined,
  hooks: DigestSnapshotPublicationTestHooks,
): Promise<ReservedDirectory> {
  let reservation = currentReservation;
  if (reservation === undefined || !reservation.active) {
    reservation = reserveNamedDirectory(parent, TARGET);
  } else {
    assertReservedDirectorySync(parent, reservation);
  }
  await hooks.afterReservedProof?.(reservedPath(parent, reservation), "restore");
  await hooks.afterRestoreProof?.(reservedPath(parent, reservation));
  replaceOwnedWithReservationSync(parent, prior, reservation, parent.bindings);
  return reservation;
}

function replaceOwnedWithReservationSync(
  parent: AnchoredDirectory,
  source: OwnedDigestDirectory,
  destination: ReservedDirectory,
  bindings: readonly CallerVisibleDirectoryBinding[],
  retained?: OwnedDigestDirectory,
): void {
  for (let proof = 0; proof < 3; proof++) {
    assertCallerVisibleBindingsSync(bindings);
    assertOwnedDirectorySync(parent, source);
    assertReservedDirectorySync(parent, destination);
    if (retained !== undefined) assertOwnedDirectorySync(parent, retained);
  }
  renameSync(ownedPath(parent, source), reservedPath(parent, destination));
  source.name = destination.name;
  destination.active = false;
  assertCallerVisibleBindingsSync(bindings);
  assertDirectoryPathIdentitySync(parent.handle, source.name, source.identity);
  source.tree = rebindAfterControlledRenameSync(source.handle, source.tree);
  if (retained !== undefined) assertOwnedDirectorySync(parent, retained);
}

async function cleanupOwnedDirectory(
  parent: AnchoredDirectory,
  owned: OwnedDigestDirectory,
  hooks: DigestSnapshotPublicationTestHooks,
  kind: "prior" | "removed" | "stage",
): Promise<void> {
  assertCallerVisibleBindingsSync(parent.bindings);
  assertOwnedDirectorySync(parent, owned);
  await hooks.afterCleanupProof?.(ownedPath(parent, owned), kind);
  assertCallerVisibleBindingsSync(parent.bindings);
  assertOwnedDirectorySync(parent, owned);

  const remaining = [...owned.tree.files];
  while (remaining.length > 0) {
    const file = remaining[0];
    const filePath = procFdChild(owned.handle.fd, file.name);
    await hooks.afterCleanupFileProof?.(filePath, kind);
    assertCallerVisibleBindingsSync(parent.bindings);
    assertDirectoryPathIdentitySync(parent.handle, owned.name, owned.identity);
    assertRemainingFilesSync(owned.handle, remaining);
    assertFileBindingSync(owned.handle, file);
    unlinkSync(filePath);
    remaining.shift();
  }

  assertCallerVisibleBindingsSync(parent.bindings);
  assertDirectoryPathIdentitySync(parent.handle, owned.name, owned.identity);
  if (readdirSync(procFd(owned.handle.fd)).length !== 0) {
    throw publicationError("cleanup found an unexpected output entry");
  }
  rmdirSync(ownedPath(parent, owned));
}

function assertRemainingFilesSync(
  directory: FileHandle,
  expected: readonly BoundDigestFile[],
): void {
  const actual = readdirSync(procFd(directory.fd)).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  const names = expected.map((file) => file.name);
  if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) {
    throw publicationError("cleanup output contents changed after proof");
  }
}

function reserveUniqueDirectory(parent: AnchoredDirectory, prefix: string): ReservedDirectory {
  for (let attempt = 0; attempt < 4; attempt++) {
    const reservation = tryReserveNamedDirectory(parent, `${prefix}${randomUUID()}`);
    if (reservation !== undefined) return reservation;
  }
  throw publicationError("could not reserve a conditional output transition");
}

function reserveNamedDirectory(parent: AnchoredDirectory, name: string): ReservedDirectory {
  const reservation = tryReserveNamedDirectory(parent, name);
  if (reservation === undefined) {
    throw publicationError("output changed before conditional publication");
  }
  return reservation;
}

function tryReserveNamedDirectory(
  parent: AnchoredDirectory,
  name: string,
): ReservedDirectory | undefined {
  const path = procFdChild(parent.handle.fd, name);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw publicationError("conditional output reservation failed");
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isDirectory()) throw publicationError("output reservation is not a directory");
    return {
      active: true,
      fd,
      identity: { dev: stat.dev, ino: stat.ino },
      name,
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof TypeError) throw error;
    throw publicationError("conditional output reservation could not be proven");
  }
}

function closeReservation(reservation: ReservedDirectory | undefined): void {
  if (reservation === undefined) return;
  try {
    closeSync(reservation.fd);
  } catch {
    // Closing an already-invalid descriptor cannot make pathname cleanup safer.
  }
}

function releaseReservationSync(
  parent: AnchoredDirectory,
  reservation: ReservedDirectory | undefined,
): void {
  if (reservation === undefined || !reservation.active) return;
  try {
    assertCallerVisibleBindingsSync(parent.bindings);
    assertReservedDirectorySync(parent, reservation);
    rmdirSync(reservedPath(parent, reservation));
    reservation.active = false;
  } catch {
    // A displaced or populated reservation is not owned by this operation and must survive.
  }
}

function assertReservedDirectorySync(
  parent: AnchoredDirectory,
  reservation: ReservedDirectory,
): void {
  if (!reservation.active) throw publicationError("output reservation is no longer active");
  const actual = fstatSync(reservation.fd, { bigint: true });
  if (
    !actual.isDirectory() ||
    actual.dev !== reservation.identity.dev ||
    actual.ino !== reservation.identity.ino ||
    readdirSync(procFd(reservation.fd)).length !== 0
  ) {
    throw publicationError("output reservation changed before conditional publication");
  }
  assertDirectoryPathIdentitySync(parent.handle, reservation.name, reservation.identity);
}

function assertOwnedDirectorySync(parent: AnchoredDirectory, owned: OwnedDigestDirectory): void {
  assertDirectoryPathIdentitySync(parent.handle, owned.name, owned.identity);
  assertBoundTreeSync(owned.handle, owned.tree);
}

function bindDigestTreeSync(directory: FileHandle): BoundDigestTree {
  try {
    const before = fstatSync(directory.fd, { bigint: true });
    if (!before.isDirectory()) throw publicationError("output snapshot is not a directory");
    const files = readdirSync(procFd(directory.fd), { withFileTypes: true })
      .map((entry) => entry.name)
      .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
      .map((name) => bindDigestFileSync(directory, name));
    const after = fstatSync(directory.fd, { bigint: true });
    if (!sameIdentity(before, after)) {
      throw publicationError("output snapshot changed while it was proven");
    }
    return { files, identity: storedIdentity(after) };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw publicationError("output snapshot contents could not be proven safely");
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
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw publicationError("output snapshot contains an unsafe file entry");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!sameIdentity(before, after)) {
      throw publicationError("output snapshot file changed while it was proven");
    }
    assertPathIdentitySync(path, after, "file");
    const digest = sha256(bytes);
    if (digest !== name) {
      throw publicationError("output snapshot digest does not match its bytes");
    }
    return { digest, identity: storedIdentity(after), name };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertBoundTreeSync(directory: FileHandle, expected: BoundDigestTree): void {
  const actual = bindDigestTreeSync(directory);
  if (
    !sameStoredIdentity(actual.identity, expected.identity) ||
    actual.files.length !== expected.files.length
  ) {
    throw publicationError("output snapshot contents changed before publication");
  }
  for (let index = 0; index < expected.files.length; index++) {
    const left = expected.files[index];
    const right = actual.files[index];
    if (
      left.name !== right.name ||
      left.digest !== right.digest ||
      !sameStoredIdentity(left.identity, right.identity)
    ) {
      throw publicationError("output snapshot contents changed before publication");
    }
  }
}

function rebindAfterControlledRenameSync(
  directory: FileHandle,
  expected: BoundDigestTree,
): BoundDigestTree {
  const actual = bindDigestTreeSync(directory);
  if (
    !sameStableDirectoryIdentity(actual.identity, expected.identity) ||
    actual.files.length !== expected.files.length
  ) {
    throw publicationError("output snapshot contents changed during conditional publication");
  }
  for (let index = 0; index < expected.files.length; index++) {
    const left = expected.files[index];
    const right = actual.files[index];
    if (
      left.name !== right.name ||
      left.digest !== right.digest ||
      !sameStoredIdentity(left.identity, right.identity)
    ) {
      throw publicationError("output snapshot contents changed during conditional publication");
    }
  }
  return actual;
}

function assertExpectedTree(tree: BoundDigestTree, files: readonly SnapshotFile[]): void {
  if (tree.files.length !== files.length) {
    throw publicationError("staged output contains an unexpected entry");
  }
  const expected = new Map(files.map((file) => [file.digest, file] as const));
  for (const actual of tree.files) {
    const file = expected.get(actual.name);
    if (
      file === undefined ||
      actual.digest !== file.digest ||
      actual.identity.size !== BigInt(file.bytes.byteLength)
    ) {
      throw publicationError("staged output bytes do not match the compiler snapshot");
    }
  }
}

function assertFileBindingSync(directory: FileHandle, expected: BoundDigestFile): void {
  const actual = bindDigestFileSync(directory, expected.name);
  if (
    actual.digest !== expected.digest ||
    !sameStoredIdentity(actual.identity, expected.identity)
  ) {
    throw publicationError("cleanup file changed after proof");
  }
}

function assertDirectoryPathIdentitySync(
  parent: FileHandle,
  name: string,
  expected: DirectoryIdentity,
): void {
  const actual = lstatSync(procFdChild(parent.fd, name), { bigint: true });
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw publicationError("output directory binding changed during publication");
  }
}

function assertPathIdentitySync(
  path: string,
  expected: BigIntStats,
  kind: "directory" | "file",
): void {
  const actual = lstatSync(path, { bigint: true });
  if (
    (kind === "directory" ? !actual.isDirectory() : !actual.isFile()) ||
    !sameIdentity(actual, expected)
  ) {
    throw publicationError("output path binding changed while it was proven");
  }
}

function assertCallerVisibleBindingsSync(bindings: readonly CallerVisibleDirectoryBinding[]): void {
  for (const binding of bindings) {
    try {
      const actual = lstatSync(binding.path, { bigint: true });
      if (
        !actual.isDirectory() ||
        actual.dev !== binding.identity.dev ||
        actual.ino !== binding.identity.ino
      ) {
        throw publicationError("output parent or ancestor changed during publication");
      }
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw publicationError("output parent or ancestor changed during publication");
    }
  }
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
    throw publicationError("platform cannot prove descriptor-anchored output containment");
  }
  const normalized = resolve(absolutePath);
  if (normalized === "/") throw publicationError("output parent cannot be the filesystem root");
  const components = normalized.split("/").filter(Boolean);
  let current = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const bindings: CallerVisibleDirectoryBinding[] = [];
  try {
    for (let index = 0; index < components.length; index++) {
      const child = await openChildDirectory(current, components[index], create);
      if (child === undefined) {
        await current.close();
        return undefined;
      }
      const stat = await child.stat({ bigint: true });
      bindings.push({
        identity: { dev: stat.dev, ino: stat.ino },
        path: `/${components.slice(0, index + 1).join("/")}`,
      });
      await current.close();
      current = child;
    }
    return { bindings, handle: current, path: normalized };
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
      throw publicationError("output directory identity could not be proven");
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

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameStoredIdentity(storedIdentity(left), storedIdentity(right));
}

function sameStoredIdentity(left: StoredIdentity, right: StoredIdentity): boolean {
  return (
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function sameStableDirectoryIdentity(left: StoredIdentity, right: StoredIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function storedIdentity(stat: BigIntStats): StoredIdentity {
  return {
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    nlink: stat.nlink,
    size: stat.size,
  };
}

function ownedPath(parent: AnchoredDirectory, owned: OwnedDigestDirectory): string {
  return procFdChild(parent.handle.fd, owned.name);
}

function reservedPath(parent: AnchoredDirectory, reserved: ReservedDirectory): string {
  return procFdChild(parent.handle.fd, reserved.name);
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
