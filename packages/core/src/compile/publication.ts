import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_FILE_SAFETY, type FileSafety } from "../assets/files";

/*
 * Safe publication of a generated output directory, shared by `topik compile` and the Astro
 * integration. A complete generation is staged in a private sibling directory, verified, and
 * renamed over the target only when the target is absent, empty, or proven (by the caller's
 * ownership predicate) to be a previous publication. On Linux every step is anchored to opened
 * directory descriptors; elsewhere a path-bound portable mode is used when file safety permits.
 */

const PUBLISHED_DIRECTORY_MODE = 0o755;

/**
 * @internal Stable category of a refused publication. Callers map it to their own public
 * wording; `undefined` marks an internal safety failure whose message is fixed and path-free.
 */
export type OutputPublicationErrorReason =
  /** The output target is a link or another non-directory. */
  | "target-collision"
  /** A directory on the output path is a link or another non-directory. */
  | "ancestor-collision"
  /** The output target is populated but the ownership predicate rejected it. */
  | "not-owned"
  /** An output ancestor could not be opened safely. */
  | "ancestor-unsafe"
  /** Anchored publication was required on a platform that cannot anchor directories. */
  | "platform-unsupported"
  /** Publication failed after the previous output was moved aside and retained. */
  | "publication-failed";

const OUTPUT_PUBLICATION_REASON_MESSAGES: Readonly<Record<OutputPublicationErrorReason, string>> = {
  "target-collision": "output target contains a link or non-directory collision",
  "ancestor-collision": "output path contains a link or non-directory component",
  "not-owned": "existing output is populated but is not recognized as owned",
  "ancestor-unsafe": "output path has an unsafe or unresolvable ancestor directory",
  "platform-unsupported": "anchored output publication requires Linux",
  "publication-failed": "output publication failed after moving the existing output aside",
};

/** @internal Fixed, path-free publication failure. */
export class OutputPublicationError extends Error {
  readonly reason: OutputPublicationErrorReason | undefined;

  constructor(message: string, reason?: OutputPublicationErrorReason, options?: ErrorOptions) {
    super(message, options);
    this.name = "OutputPublicationError";
    this.reason = reason;
  }
}

function refused(reason: OutputPublicationErrorReason, options?: ErrorOptions) {
  return new OutputPublicationError(OUTPUT_PUBLICATION_REASON_MESSAGES[reason], reason, options);
}

/** @internal One file of a staged output generation, at a `/`-separated relative path. */
export interface OutputPublicationFile {
  path: string;
  bytes: string | Uint8Array;
}

/** @internal An entry of an existing output tree, bound to the bytes that were inspected. */
export type OwnedOutputEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "file"; size: bigint; digest: string };

/**
 * @internal Decide whether a populated, link-free output tree is a previous publication.
 * `readFile` returns the bytes of a listed file and throws if they changed since inspection.
 * Returning `false` or throwing refuses the publication with reason `not-owned`.
 */
export type OutputOwnershipPredicate = (
  entries: readonly OwnedOutputEntry[],
  readFile: (path: string) => Uint8Array,
) => boolean;

/** @internal Options shared by {@link publishOutputDirectory} and {@link removeOutputDirectory}. */
export interface OutputDirectoryOptions {
  /** Defaults to {@link DEFAULT_FILE_SAFETY}; Linux always publishes anchored. */
  fileSafety?: FileSafety;
  /** Name prefix of the sibling directory a previous output is moved to before removal. */
  priorPrefix: string;
  isOwned: OutputOwnershipPredicate;
}

/** @internal */
export interface OutputPublicationOptions extends OutputDirectoryOptions {
  /** Name prefix of the private sibling directory a generation is staged in. */
  generationPrefix: string;
  /** Top-level directories every generation contains, even when empty. */
  directories: readonly string[];
  /** Mode of published files, for example `0o644`. Directories are always `0o755`. */
  fileMode: number;
  /**
   * When publication fails after the previous output was moved aside: `false` (default) keeps
   * it for manual recovery and throws reason `publication-failed`; `true` removes it, for
   * regenerable output whose leftover backup would otherwise be served.
   */
  removePriorOnFailure?: boolean;
}

/**
 * @internal Publish `files` as the complete content of `absolutePath`, replacing only an
 * absent or empty directory or a previous output accepted by `isOwned`.
 */
export async function publishOutputDirectory(
  absolutePath: string,
  files: readonly OutputPublicationFile[],
  options: OutputPublicationOptions,
): Promise<void> {
  // Linux always publishes through anchored descriptors. Elsewhere the portable path is used
  // only when permitted; otherwise openAnchoredOutputDirectory refuses the platform.
  if (process.platform !== "linux" && (options.fileSafety ?? DEFAULT_FILE_SAFETY) === "portable") {
    publishOutputDirectoryByPath(absolutePath, files, options);
    return;
  }
  const stagedFiles = snapshotOutputFiles(files);
  const target = basename(absolutePath);
  if (target.length === 0 || target === "." || target === "..") {
    throw new OutputPublicationError("output root is invalid");
  }
  const anchoredParent = await openAnchoredOutputDirectory(dirname(absolutePath), true);
  if (anchoredParent === undefined) {
    throw new OutputPublicationError("output parent could not be created");
  }
  const parent = anchoredParent.handle;
  let existing: OwnedOutputDirectory | undefined;
  let generation: OwnedTemporaryDirectory | undefined;
  let published = false;
  let existingRemoved = false;
  let operationError: unknown;
  try {
    const targetPath = procFdChild(parent.fd, target);
    existing = await openOwnedOutput(parent, target, options.isOwned);
    generation = await createOwnedTemporaryDirectory(parent, options.generationPrefix);
    for (const directory of options.directories) {
      const handle = await openAnchoredChildDirectory(generation.handle, directory, true);
      if (handle === undefined) {
        throw new OutputPublicationError("output directory is unavailable");
      }
      await handle.close();
    }
    for (const file of stagedFiles) {
      await writeAnchoredFile(generation.handle, file.path, file.bytes, options.fileMode);
    }
    generation.tree = bindCompleteOutputTreeSync(generation.handle);
    assertExpectedStagedTree(generation.tree, stagedFiles, options.directories);
    // mkdtemp creates the staging root as 0700; widen it only once fully staged.
    await generation.handle.chmod(PUBLISHED_DIRECTORY_MODE);

    if (existing !== undefined) {
      const priorName = `${options.priorPrefix}${randomUUID()}`;
      assertOutputPathAbsent(procFdChild(parent.fd, priorName));
      renameSync(targetPath, procFdChild(parent.fd, priorName));
      existing.name = priorName;
    }

    renameSync(generation.path, targetPath);
    generation.path = targetPath;
    generation.name = target;
    published = true;

    if (existing !== undefined) {
      cleanupOutputDirectory(parent, existing);
      existingRemoved = true;
    }
  } catch (error) {
    operationError = error;
  }
  if (!published && existing !== undefined && existing.name !== target) {
    if (options.removePriorOnFailure === true) {
      try {
        cleanupOutputDirectory(parent, existing);
        existingRemoved = true;
      } catch (error) {
        operationError ??= error;
      }
    } else {
      // A later rename cannot atomically verify the backup identity and refuse an
      // occupied target. Leave recovery to the operator and retain the original error.
      operationError = refused("publication-failed", { cause: operationError });
    }
  }
  if (generation !== undefined && !published) {
    try {
      generation.tree = bindCompleteOutputTreeSync(generation.handle);
      cleanupOutputDirectory(parent, generation);
    } catch (error) {
      operationError ??= error;
    }
  }
  if (published && existing !== undefined && !existingRemoved && existing.name !== target) {
    try {
      cleanupOutputDirectory(parent, existing);
    } catch (error) {
      operationError ??= error;
    }
  }
  await generation?.handle.close().catch(() => undefined);
  await existing?.handle.close().catch(() => undefined);
  await parent.close().catch(() => undefined);
  if (operationError !== undefined) throw operationError;
}

/**
 * @internal Remove `absolutePath` when it is an empty directory or a previous output accepted
 * by `isOwned`. A missing target or parent is not an error; nothing is created.
 */
export async function removeOutputDirectory(
  absolutePath: string,
  options: OutputDirectoryOptions,
): Promise<void> {
  if (process.platform !== "linux" && (options.fileSafety ?? DEFAULT_FILE_SAFETY) === "portable") {
    removeOutputDirectoryByPath(absolutePath, options);
    return;
  }
  const target = basename(absolutePath);
  if (target.length === 0 || target === "." || target === "..") {
    throw new OutputPublicationError("output root is invalid");
  }
  const anchoredParent = await openAnchoredOutputDirectory(dirname(absolutePath), false);
  if (anchoredParent === undefined) return;
  const parent = anchoredParent.handle;
  let existing: OwnedOutputDirectory | undefined;
  let existingRemoved = false;
  let operationError: unknown;
  try {
    existing = await openOwnedOutput(parent, target, options.isOwned);
    if (existing === undefined) {
      // An empty target holds nothing to preserve; rmdir(2) refuses it once populated.
      if (await outputEntryExists(procFdChild(parent.fd, target))) {
        rmdirSync(procFdChild(parent.fd, target));
      }
    } else {
      const priorName = `${options.priorPrefix}${randomUUID()}`;
      assertOutputPathAbsent(procFdChild(parent.fd, priorName));
      renameSync(procFdChild(parent.fd, target), procFdChild(parent.fd, priorName));
      existing.name = priorName;
      cleanupOutputDirectory(parent, existing);
      existingRemoved = true;
    }
  } catch (error) {
    operationError = error;
  }
  if (!existingRemoved && existing !== undefined && existing.name !== target) {
    try {
      cleanupOutputDirectory(parent, existing);
    } catch (error) {
      operationError ??= error;
    }
  }
  await existing?.handle.close().catch(() => undefined);
  await parent.close().catch(() => undefined);
  if (operationError !== undefined) throw operationError;
}

interface OwnedTemporaryDirectory {
  name: string;
  path: string;
  handle: FileHandle;
  tree: BoundOutputTree;
}

async function createOwnedTemporaryDirectory(
  parent: FileHandle,
  prefix: string,
): Promise<OwnedTemporaryDirectory> {
  const path = await mkdtemp(procFdChild(parent.fd, prefix));
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw new OutputPublicationError("staging identity is invalid");
    return { name: basename(path), path, handle, tree: { entries: [] } };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    try {
      rmdirSync(procFdChild(parent.fd, basename(path)));
    } catch {
      // The staging-open failure remains the actionable error.
    }
    if (error instanceof OutputPublicationError) throw error;
    throw new OutputPublicationError("staging directory could not be opened safely");
  }
}

type OwnedOutputDirectory = OwnedTemporaryDirectory;

async function openOwnedOutput(
  parent: FileHandle,
  target: string,
  isOwned: OutputOwnershipPredicate,
): Promise<OwnedOutputDirectory | undefined> {
  const targetPath = procFdChild(parent.fd, target);
  let stat: BigIntStats;
  try {
    stat = await lstat(targetPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new OutputPublicationError("output target could not be inspected safely");
  }

  if (!stat.isDirectory()) {
    throw refused("target-collision");
  }
  const directory = await openAnchoredChildDirectory(parent, target, false);
  if (directory === undefined) {
    throw new OutputPublicationError("output directory could not be opened safely");
  }
  try {
    // The opened directory must be the one inspected above.
    const actual = await directory.stat({ bigint: true });
    if (actual.dev !== stat.dev || actual.ino !== stat.ino) {
      throw new OutputPublicationError("output target identity is inconsistent");
    }
    const tree = bindCompleteOutputTreeSync(directory);
    if (tree.entries.length === 1 && tree.entries[0]?.path === "") {
      // An empty directory (for example a pre-created CI cache or volume path) holds
      // nothing to preserve. Publication renames over it, and rename(2) refuses
      // the replacement if anything appears in it meanwhile.
      await directory.close();
      return undefined;
    }
    assertOwnedOutputTree(isOwned, (path) => readBoundOutputFileSync(directory, tree, path), tree);
    return { handle: directory, name: target, path: targetPath, tree };
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
}

async function outputEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new OutputPublicationError("output target could not be inspected safely");
  }
}

function cleanupOutputDirectory(
  parent: FileHandle,
  directory: Pick<OwnedTemporaryDirectory, "handle" | "name" | "tree">,
): void {
  for (const entry of [...directory.tree.entries].reverse()) {
    if (entry.path.length === 0) continue;
    const path = `${procFd(directory.handle.fd)}/${entry.path}`;
    if (entry.kind === "file") unlinkSync(path);
    else rmdirSync(path);
  }
  rmdirSync(procFdChild(parent.fd, directory.name));
}

function assertOutputPathAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new OutputPublicationError("replacement storage could not be inspected safely");
  }
  throw new OutputPublicationError("replacement storage is already occupied");
}

function assertOwnedOutputTree(
  isOwned: OutputOwnershipPredicate,
  readFile: (path: string) => Uint8Array,
  tree: BoundOutputTree,
): void {
  try {
    const entries = tree.entries.map((entry): OwnedOutputEntry =>
      entry.kind === "directory"
        ? { path: entry.path, kind: "directory" }
        : { path: entry.path, kind: "file", size: entry.identity.size, digest: entry.digest },
    );
    if (!isOwned(entries, readFile)) throw new TypeError("Output is not owned");
  } catch {
    throw refused("not-owned");
  }
}

function readBoundOutputFileSync(
  root: FileHandle,
  tree: BoundOutputTree,
  path: string,
): Uint8Array {
  safeOutputComponents(path);
  const expected = tree.entries.find(
    (entry): entry is Extract<BoundOutputTreeEntry, { kind: "file" }> =>
      entry.kind === "file" && entry.path === path,
  );
  if (expected === undefined) throw new TypeError("Output descriptor is unavailable");

  let fileFd: number | undefined;
  try {
    const anchoredPath = `${procFd(root.fd)}/${path}`;
    fileFd = openSync(
      anchoredPath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
    );
    const before = fstatSync(fileFd, { bigint: true });
    if (
      !before.isFile() ||
      !sameStoredOutputIdentity(toBoundOutputIdentity(before), expected.identity)
    ) {
      throw new TypeError("Output descriptor identity changed");
    }
    const bytes = readFileSync(fileFd);
    const after = fstatSync(fileFd, { bigint: true });
    if (!sameBoundOutputIdentity(before, after) || sha256OutputBytes(bytes) !== expected.digest) {
      throw new TypeError("Output descriptor bytes changed");
    }
    assertPathStillBindsIdentitySync(anchoredPath, after, "file");
    return Uint8Array.from(bytes);
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
  }
}

async function openAnchoredOutputDirectory(
  absolutePath: string,
  create: boolean,
): Promise<AnchoredOutputDirectory | undefined> {
  if (
    process.platform !== "linux" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw refused("platform-unsupported");
  }
  const normalized = resolve(absolutePath);
  if (normalized === "/")
    throw new OutputPublicationError("output root cannot be the filesystem root");
  const components = normalized.split("/").filter(Boolean);
  let current = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const child = await openAnchoredChildDirectory(current, component, create);
      if (child === undefined) {
        await current.close();
        return undefined;
      }
      await current.close();
      current = child;
    }
    return { handle: current };
  } catch (error) {
    await current.close().catch(() => undefined);
    if (error instanceof OutputPublicationError) throw error;
    throw refused("ancestor-unsafe");
  }
}

interface AnchoredOutputDirectory {
  handle: FileHandle;
}

interface StagedOutputFile {
  path: string;
  bytes: Uint8Array;
  digest: string;
}

interface BoundOutputIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
}

type BoundOutputTreeEntry =
  | { path: string; kind: "directory"; identity: BoundOutputIdentity }
  | { path: string; kind: "file"; identity: BoundOutputIdentity; digest: string };

interface BoundOutputTree {
  entries: readonly BoundOutputTreeEntry[];
}

function snapshotOutputFiles(files: readonly OutputPublicationFile[]): readonly StagedOutputFile[] {
  const paths = new Set<string>();
  const snapshots = files.map((file) => {
    safeOutputComponents(file.path);
    if (paths.has(file.path)) {
      throw new OutputPublicationError("output repeats a staged file path");
    }
    paths.add(file.path);
    const bytes =
      typeof file.bytes === "string"
        ? Uint8Array.from(Buffer.from(file.bytes, "utf8"))
        : Uint8Array.from(file.bytes);
    return { path: file.path, bytes, digest: sha256OutputBytes(bytes) };
  });
  for (const path of paths) {
    const components = safeOutputComponents(path);
    for (let index = 1; index < components.length; index++) {
      if (paths.has(components.slice(0, index).join("/"))) {
        throw new OutputPublicationError("output has a parent/file collision");
      }
    }
  }
  return snapshots;
}

function bindCompleteOutputTreeSync(root: FileHandle): BoundOutputTree {
  const entries: BoundOutputTreeEntry[] = [];
  try {
    inspectBoundDirectorySync(root.fd, "", entries);
  } catch (error) {
    if (error instanceof OutputPublicationError) throw error;
    throw new OutputPublicationError("generation contents could not be inspected safely");
  }
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  return { entries };
}

function inspectBoundDirectorySync(
  directoryFd: number,
  prefix: string,
  entries: BoundOutputTreeEntry[],
): void {
  const before = fstatSync(directoryFd, { bigint: true });
  if (!before.isDirectory()) {
    throw new OutputPublicationError("generation contains an unsafe directory entry");
  }
  const children = readdirSync(procFd(directoryFd), { withFileTypes: true }).sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
  );
  for (const child of children) {
    const path = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
    const anchoredPath = procFdChild(directoryFd, child.name);
    if (child.isDirectory()) {
      let childFd: number | undefined;
      try {
        childFd = openSync(
          anchoredPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        inspectBoundDirectorySync(childFd, path, entries);
        const actual = fstatSync(childFd, { bigint: true });
        assertPathStillBindsIdentitySync(anchoredPath, actual, "directory");
      } finally {
        if (childFd !== undefined) closeSync(childFd);
      }
      continue;
    }
    if (!child.isFile()) {
      throw new OutputPublicationError("generation contains a link or special-node entry");
    }

    let fileFd: number | undefined;
    try {
      fileFd = openSync(
        anchoredPath,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
      );
      const fileBefore = fstatSync(fileFd, { bigint: true });
      if (!fileBefore.isFile() || fileBefore.nlink !== 1n) {
        throw new OutputPublicationError("generation contains a hard link or unsafe file entry");
      }
      const bytes = readFileSync(fileFd);
      const fileAfter = fstatSync(fileFd, { bigint: true });
      if (!sameBoundOutputIdentity(fileBefore, fileAfter)) {
        throw new OutputPublicationError("generation file changed while it was inspected");
      }
      assertPathStillBindsIdentitySync(anchoredPath, fileAfter, "file");
      entries.push({
        path,
        kind: "file",
        identity: toBoundOutputIdentity(fileAfter),
        digest: sha256OutputBytes(bytes),
      });
    } finally {
      if (fileFd !== undefined) closeSync(fileFd);
    }
  }
  const after = fstatSync(directoryFd, { bigint: true });
  if (!sameBoundOutputIdentity(before, after)) {
    throw new OutputPublicationError("generation directory changed while it was inspected");
  }
  entries.push({ path: prefix, kind: "directory", identity: toBoundOutputIdentity(after) });
}

function assertPathStillBindsIdentitySync(
  path: string,
  expected: BigIntStats,
  kind: "directory" | "file",
): void {
  const actual = lstatSync(path, { bigint: true });
  if (
    (kind === "directory" ? !actual.isDirectory() : !actual.isFile()) ||
    !sameBoundOutputIdentity(actual, expected)
  ) {
    throw new OutputPublicationError("generation path binding changed while it was inspected");
  }
}

function assertExpectedStagedTree(
  tree: BoundOutputTree,
  files: readonly StagedOutputFile[],
  directories: readonly string[],
): void {
  const expectedDirectories = new Set<string>([""]);
  for (const directory of directories) expectedDirectories.add(directory);
  const expectedFiles = new Map(files.map((file) => [file.path, file] as const));
  for (const file of files) {
    const components = safeOutputComponents(file.path);
    for (let index = 1; index < components.length; index++) {
      expectedDirectories.add(components.slice(0, index).join("/"));
    }
  }
  if (tree.entries.length !== expectedDirectories.size + expectedFiles.size) {
    throw new OutputPublicationError("staged generation contains an unexpected path");
  }
  for (const entry of tree.entries) {
    if (entry.kind === "directory") {
      if (!expectedDirectories.has(entry.path)) {
        throw new OutputPublicationError("staged generation contains an unexpected directory");
      }
      continue;
    }
    const expected = expectedFiles.get(entry.path);
    if (
      expected === undefined ||
      entry.identity.size !== BigInt(expected.bytes.byteLength) ||
      entry.digest !== expected.digest
    ) {
      throw new OutputPublicationError("staged generation bytes do not match expected output");
    }
  }
}

function sameBoundOutputIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameStoredOutputIdentity(toBoundOutputIdentity(left), toBoundOutputIdentity(right));
}

function sameStoredOutputIdentity(left: BoundOutputIdentity, right: BoundOutputIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function toBoundOutputIdentity(stat: BigIntStats): BoundOutputIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
  };
}

function sha256OutputBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function openAnchoredChildDirectory(
  parent: FileHandle,
  component: string,
  create: boolean,
): Promise<FileHandle | undefined> {
  if (
    component.length === 0 ||
    component === "." ||
    component === ".." ||
    component.includes("/")
  ) {
    throw new OutputPublicationError("output path is invalid");
  }
  const path = procFdChild(parent.fd, component);
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw refused("ancestor-collision");
    }
    const created = await mkdir(path, { mode: 0o700 }).then(
      () => true,
      (mkdirError) => {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        return false;
      },
    );
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      throw new OutputPublicationError("output directory identity could not be proven");
    }
    if (created) {
      try {
        // Published directories must be traversable by other users (for example a
        // web server), matching the world-readable mode of published files.
        await handle.chmod(PUBLISHED_DIRECTORY_MODE);
      } catch {
        await handle.close().catch(() => undefined);
        throw new OutputPublicationError("output directory permissions could not be set");
      }
    }
    return handle;
  }
}

async function writeAnchoredFile(
  root: FileHandle,
  relativePath: string,
  bytes: string | Uint8Array,
  fileMode: number,
): Promise<void> {
  const components = safeOutputComponents(relativePath);
  const directories: FileHandle[] = [];
  let parent = root;
  let output: FileHandle | undefined;
  try {
    for (const component of components.slice(0, -1)) {
      const child = await openAnchoredChildDirectory(parent, component, true);
      if (child === undefined) throw new OutputPublicationError("output directory is unavailable");
      directories.push(child);
      parent = child;
    }
    const path = procFdChild(parent.fd, components.at(-1) ?? "");
    output = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await output.writeFile(bytes);
    await output.chmod(fileMode);
  } finally {
    await output?.close().catch(() => undefined);
    await Promise.all(directories.map((handle) => handle.close().catch(() => undefined)));
  }
}

function safeOutputComponents(relativePath: string): string[] {
  const components = relativePath.split("/");
  if (
    relativePath.startsWith("/") ||
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        component.includes("\\"),
    )
  ) {
    throw new OutputPublicationError("output path is not safely relative");
  }
  return components;
}

function procFd(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function procFdChild(fd: number, component: string): string {
  return `${procFd(fd)}/${component}`;
}

/*
 * Portable publication for platforms without descriptor-anchored directories (macOS,
 * Windows), used only when the caller permits portable file safety. It keeps the anchored
 * flow (stage a complete generation beside the target, verify it, prove ownership of any
 * existing output, rename) but binds every entry by path: entries are inspected without
 * following links and the opened handle must be the inspected entry. Like the portable
 * readers, this cannot contain another process concurrently swapping path components.
 */
function publishOutputDirectoryByPath(
  absolutePath: string,
  files: readonly OutputPublicationFile[],
  options: OutputPublicationOptions,
): void {
  const stagedFiles = snapshotOutputFiles(files);
  const target = basename(absolutePath);
  if (target.length === 0 || target === "." || target === "..") {
    throw new OutputPublicationError("output root is invalid");
  }
  const parent = preparePortableOutputParent(dirname(absolutePath));
  const targetPath = join(parent, target);
  let existing: PortableOutputTree | undefined;
  let emptyTarget = false;
  let generation: PortableOutputTree | undefined;
  let published = false;
  let existingRemoved = false;
  let operationError: unknown;
  try {
    const inspected = inspectPortableOutputTarget(targetPath, options.isOwned);
    existing = inspected.existing;
    emptyTarget = inspected.empty;
    generation = {
      path: createPortableGeneration(parent, options.generationPrefix),
      tree: { entries: [] },
    };
    for (const directory of options.directories) {
      createPortableOutputDirectory(join(generation.path, directory));
    }
    for (const file of stagedFiles) {
      writePortableOutputFile(generation.path, file.path, file.bytes, options.fileMode);
    }
    generation.tree = bindPortableOutputTreeSync(generation.path);
    assertExpectedStagedTree(generation.tree, stagedFiles, options.directories);
    chmodSync(generation.path, PUBLISHED_DIRECTORY_MODE);

    if (existing !== undefined) {
      movePortableTreeAside(parent, existing, options.priorPrefix);
    } else if (emptyTarget && process.platform === "win32") {
      // Windows cannot rename a directory over another one; rmdir refuses a non-empty target.
      rmdirSync(targetPath);
    }

    renameSync(generation.path, targetPath);
    generation.path = targetPath;
    published = true;

    if (existing !== undefined) {
      cleanupPortableTree(existing);
      existingRemoved = true;
    }
  } catch (error) {
    operationError = error;
  }
  if (!published && existing !== undefined && existing.path !== targetPath) {
    if (options.removePriorOnFailure === true) {
      try {
        cleanupPortableTree(existing);
        existingRemoved = true;
      } catch (error) {
        operationError ??= error;
      }
    } else {
      operationError = refused("publication-failed", { cause: operationError });
    }
  }
  if (generation !== undefined && !published) {
    try {
      generation.tree = bindPortableOutputTreeSync(generation.path);
      cleanupPortableTree(generation);
    } catch (error) {
      operationError ??= error;
    }
  }
  if (published && existing !== undefined && !existingRemoved && existing.path !== targetPath) {
    try {
      cleanupPortableTree(existing);
    } catch (error) {
      operationError ??= error;
    }
  }
  if (operationError !== undefined) throw operationError;
}

function removeOutputDirectoryByPath(absolutePath: string, options: OutputDirectoryOptions): void {
  const target = basename(absolutePath);
  if (target.length === 0 || target === "." || target === "..") {
    throw new OutputPublicationError("output root is invalid");
  }
  const parent = existingPortableOutputParent(dirname(absolutePath));
  if (parent === undefined) return;
  const targetPath = join(parent, target);
  let existing: PortableOutputTree | undefined;
  let existingRemoved = false;
  let operationError: unknown;
  try {
    const inspected = inspectPortableOutputTarget(targetPath, options.isOwned);
    existing = inspected.existing;
    if (inspected.empty) {
      // rmdir refuses the target once anything appears in it.
      rmdirSync(targetPath);
    } else if (existing !== undefined) {
      movePortableTreeAside(parent, existing, options.priorPrefix);
      cleanupPortableTree(existing);
      existingRemoved = true;
    }
  } catch (error) {
    operationError = error;
  }
  if (!existingRemoved && existing !== undefined && existing.path !== targetPath) {
    try {
      cleanupPortableTree(existing);
    } catch (error) {
      operationError ??= error;
    }
  }
  if (operationError !== undefined) throw operationError;
}

interface PortableOutputTree {
  path: string;
  tree: BoundOutputTree;
}

/** Create missing parents, then use the canonical parent so aliases above it are allowed. */
function preparePortableOutputParent(absolutePath: string): string {
  try {
    const firstCreated = mkdirSync(absolutePath, {
      recursive: true,
      mode: PUBLISHED_DIRECTORY_MODE,
    });
    // The umask narrows mkdir's mode. Like the anchored path, widen only the directories
    // created here so other users (a web server) can reach the output; existing ones keep
    // their permissions.
    if (firstCreated !== undefined) {
      const created = [resolve(absolutePath)];
      while (created[0] !== resolve(firstCreated) && dirname(created[0]) !== created[0]) {
        created.unshift(dirname(created[0]));
      }
      for (const directory of created) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Not a directory");
        chmodSync(directory, PUBLISHED_DIRECTORY_MODE);
      }
    }
    return canonicalPortableOutputParent(absolutePath);
  } catch (error) {
    if (error instanceof OutputPublicationError) throw error;
    throw refused("ancestor-unsafe");
  }
}

/** The canonical parent when it exists, without creating anything. */
function existingPortableOutputParent(absolutePath: string): string | undefined {
  try {
    return canonicalPortableOutputParent(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw refused("ancestor-unsafe");
  }
}

function canonicalPortableOutputParent(absolutePath: string): string {
  const canonical = realpathSync.native(absolutePath);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Not a directory");
  return canonical;
}

function inspectPortableOutputTarget(
  targetPath: string,
  isOwned: OutputOwnershipPredicate,
): {
  existing?: PortableOutputTree;
  empty: boolean;
} {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { empty: false };
    throw new OutputPublicationError("output target could not be inspected safely");
  }
  // A symbolic link (or Windows junction) is never followed into someone else's directory.
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw refused("target-collision");
  }
  const tree = bindPortableOutputTreeSync(targetPath);
  if (tree.entries.length === 1 && tree.entries[0]?.path === "") return { empty: true };
  assertOwnedOutputTree(isOwned, (path) => readPortableBoundFileSync(targetPath, tree, path), tree);
  return { existing: { path: targetPath, tree }, empty: false };
}

function movePortableTreeAside(
  parent: string,
  existing: PortableOutputTree,
  priorPrefix: string,
): void {
  assertPortableTreeRoot(existing);
  const priorPath = join(parent, `${priorPrefix}${randomUUID()}`);
  assertOutputPathAbsent(priorPath);
  renameSync(existing.path, priorPath);
  existing.path = priorPath;
}

function createPortableGeneration(parent: string, prefix: string): string {
  // mkdtemp creates the staging root as 0700; it is widened only once fully staged.
  const path = mkdtempSync(join(parent, prefix));
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OutputPublicationError("staging identity is invalid");
  }
  return path;
}

function createPortableOutputDirectory(path: string): void {
  // Fails if anything already occupies the name; the generation is private until published.
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, PUBLISHED_DIRECTORY_MODE);
}

function writePortableOutputFile(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
  fileMode: number,
): void {
  const components = safeOutputComponents(relativePath);
  let directory = root;
  for (const component of components.slice(0, -1)) {
    directory = join(directory, component);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new OutputPublicationError("output directory is unavailable");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      createPortableOutputDirectory(directory);
    }
  }
  // "wx" creates exclusively and refuses an existing entry, including a link.
  writeFileSync(join(directory, components.at(-1) ?? ""), bytes, { flag: "wx", mode: 0o600 });
  chmodSync(join(directory, components.at(-1) ?? ""), fileMode);
}

const PORTABLE_OUTPUT_READ_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
  (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);

function bindPortableOutputTreeSync(root: string): BoundOutputTree {
  const entries: BoundOutputTreeEntry[] = [];
  try {
    inspectPortableDirectorySync(root, "", entries);
  } catch (error) {
    if (error instanceof OutputPublicationError) throw error;
    throw new OutputPublicationError("generation contents could not be inspected safely");
  }
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  return { entries };
}

function inspectPortableDirectorySync(
  path: string,
  prefix: string,
  entries: BoundOutputTreeEntry[],
): void {
  const before = lstatSync(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new OutputPublicationError("generation contains an unsafe directory entry");
  }
  const children = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
  );
  for (const child of children) {
    const relativePath = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
    const childPath = join(path, child.name);
    if (child.isDirectory()) {
      inspectPortableDirectorySync(childPath, relativePath, entries);
      continue;
    }
    if (!child.isFile()) {
      throw new OutputPublicationError("generation contains a link or special-node entry");
    }
    const { bytes, identity } = readPortableEntrySync(childPath);
    entries.push({
      path: relativePath,
      kind: "file",
      identity: toBoundOutputIdentity(identity),
      digest: sha256OutputBytes(bytes),
    });
  }
  const after = lstatSync(path, { bigint: true });
  if (after.isSymbolicLink() || !sameBoundOutputIdentity(before, after)) {
    throw new OutputPublicationError("generation directory changed while it was inspected");
  }
  entries.push({ path: prefix, kind: "directory", identity: toBoundOutputIdentity(after) });
}

/** Read a single-link regular file whose opened handle is the entry named by `path`. */
function readPortableEntrySync(path: string): { bytes: Buffer; identity: BigIntStats } {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new OutputPublicationError("generation contains a link or special-node entry");
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, PORTABLE_OUTPUT_READ_FLAGS);
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.dev !== entry.dev ||
      before.ino !== entry.ino
    ) {
      throw new OutputPublicationError("generation contains a hard link or unsafe file entry");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const again = lstatSync(path, { bigint: true });
    if (
      !sameBoundOutputIdentity(before, after) ||
      again.isSymbolicLink() ||
      !sameBoundOutputIdentity(again, after)
    ) {
      throw new OutputPublicationError("generation file changed while it was inspected");
    }
    return { bytes, identity: after };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPortableBoundFileSync(root: string, tree: BoundOutputTree, path: string): Uint8Array {
  const components = safeOutputComponents(path);
  const expected = tree.entries.find(
    (entry): entry is Extract<BoundOutputTreeEntry, { kind: "file" }> =>
      entry.kind === "file" && entry.path === path,
  );
  if (expected === undefined) throw new TypeError("Output descriptor is unavailable");
  const { bytes, identity } = readPortableEntrySync(join(root, ...components));
  if (
    !sameStoredOutputIdentity(toBoundOutputIdentity(identity), expected.identity) ||
    sha256OutputBytes(bytes) !== expected.digest
  ) {
    throw new TypeError("Output descriptor bytes changed");
  }
  return Uint8Array.from(bytes);
}

/** The directory about to be moved aside must still be the one whose ownership was proven. */
function assertPortableTreeRoot(tree: PortableOutputTree): void {
  const root = tree.tree.entries.find((entry) => entry.kind === "directory" && entry.path === "");
  const actual = lstatSync(tree.path, { bigint: true });
  if (
    root === undefined ||
    actual.isSymbolicLink() ||
    !actual.isDirectory() ||
    !sameStoredOutputIdentity(toBoundOutputIdentity(actual), root.identity)
  ) {
    throw new OutputPublicationError("output changed after its ownership was proven");
  }
}

/** Remove exactly the bound entries, refusing any entry whose identity changed. */
function cleanupPortableTree(tree: PortableOutputTree): void {
  for (const entry of [...tree.tree.entries].reverse()) {
    const path = entry.path.length === 0 ? tree.path : join(tree.path, ...entry.path.split("/"));
    const actual = lstatSync(path, { bigint: true });
    if (
      actual.isSymbolicLink() ||
      actual.dev !== entry.identity.dev ||
      actual.ino !== entry.identity.ino
    ) {
      throw new OutputPublicationError("cleanup entry changed while it was removed");
    }
    if (entry.kind === "file") unlinkSync(path);
    else rmdirSync(path);
  }
}
