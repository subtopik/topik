import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { PublicCompileError } from "./public-errors";

// Linux O_PATH (asm-generic/fcntl.h); Node does not expose this flag. Directory
// descriptors need search permission only, including ancestors above the source root.
const LINUX_O_PATH = 0o10000000;

const SAFE_READ_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
  (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);

export class FileOutsideCompilationRootError extends PublicCompileError {
  constructor(filePath: string, rootDir: string) {
    super("file-outside-compilation-root", safeRelativePath(filePath, rootDir));
    this.name = "FileOutsideCompilationRootError";
  }
}

export class FileNotRegularError extends PublicCompileError {
  constructor(filePath: string, rootDir: string) {
    super("file-not-regular", safeRelativePath(filePath, rootDir));
    this.name = "FileNotRegularError";
  }
}

export async function readRegularFileWithinRoot(filePath: string, rootDir: string): Promise<Buffer>;
export async function readRegularFileWithinRoot(
  filePath: string,
  rootDir: string,
  encoding: BufferEncoding,
): Promise<string>;
export async function readRegularFileWithinRoot(
  filePath: string,
  rootDir: string,
  encoding?: BufferEncoding,
): Promise<Buffer | string> {
  const handle = await openRegularFileWithinRoot(filePath, rootDir);
  try {
    return encoding == null ? await handle.readFile() : await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}

export async function assertRegularFileWithinRoot(
  filePath: string,
  rootDir: string,
): Promise<void> {
  const handle = await openRegularFileWithinRoot(filePath, rootDir);
  await handle.close();
}

async function openRegularFileWithinRoot(filePath: string, rootDir: string): Promise<FileHandle> {
  if (
    process.platform === "linux" &&
    (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number")
  ) {
    throw new PublicCompileError("file-safe-read-unsupported", safeRelativePath(filePath, rootDir));
  }
  const authoredRoot = resolve(rootDir);
  const authoredFile = resolve(filePath);
  if (!isWithinRoot(authoredRoot, authoredFile)) {
    throw new FileOutsideCompilationRootError(filePath, rootDir);
  }
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootDir), realpath(filePath)]);
  if (!isWithinRoot(canonicalRoot, canonicalFile)) {
    throw new FileOutsideCompilationRootError(filePath, rootDir);
  }
  // Portable reads allow canonical aliases above the source root (such as macOS /var),
  // but still reject a symlinked root or a path redirected within it. Linux traversal
  // also rejects aliases above the root because it opens every authored component.
  // Keep exact spelling below the canonical root: Windows path.relative folds case
  // even when the filesystem contains distinct case-sensitive entries.
  const expectedFile = resolve(canonicalRoot, relative(authoredRoot, authoredFile));
  if (
    process.platform === "linux"
      ? authoredRoot !== canonicalRoot || authoredFile !== canonicalFile
      : !(await lstat(authoredRoot)).isDirectory() || expectedFile !== canonicalFile
  ) {
    throw new FileNotRegularError(filePath, rootDir);
  }

  // Check before opening so directories and special files (notably FIFOs) cannot block or
  // produce platform-specific read errors. The handle is checked again after opening.
  const initialStat = await lstat(canonicalFile, { bigint: true });
  if (!initialStat.isFile()) {
    throw new FileNotRegularError(filePath, rootDir);
  }

  return process.platform === "linux"
    ? openAnchoredLinuxFile(authoredFile, rootDir)
    : openPortableFile(filePath, rootDir, canonicalFile, initialStat);
}

async function openPortableFile(
  filePath: string,
  rootDir: string,
  canonicalFile: string,
  initialStat: BigIntStats,
): Promise<FileHandle> {
  // These pathname checks are ordinary containment, not a boundary against hostile
  // concurrent filesystem mutation. Validate and read the same handle; identity checks
  // also reject ordinary replacements when O_NOFOLLOW is unavailable.
  let handle: FileHandle | undefined;
  try {
    handle = await open(canonicalFile, SAFE_READ_FLAGS);
    const openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isFile() ||
      initialStat.dev !== openedStat.dev ||
      initialStat.ino !== openedStat.ino
    ) {
      throw new FileNotRegularError(filePath, rootDir);
    }
    return handle;
  } catch (error) {
    await handle?.close();
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new FileNotRegularError(filePath, rootDir);
    }
    throw error;
  }
}

async function openAnchoredLinuxFile(filePath: string, rootDir: string): Promise<FileHandle> {
  // Anchor every component, including the ancestors of the compilation root. Pathname
  // checks above provide diagnostics only: no later open traverses a mutable ancestor.
  const directories: FileHandle[] = [];
  let handle: FileHandle | undefined;
  try {
    const filesystemRoot = parse(filePath).root;
    const components = relative(filesystemRoot, filePath).split(sep);
    const directoryFlags = LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    directories.push(await open(filesystemRoot, directoryFlags));
    // Node has no openat API. Linux procfs lets us resolve a single child against a held
    // directory descriptor; O_NOFOLLOW applies to that child, never a multi-part path.
    // If procfs is unavailable, fail explicitly instead of downgrading to pathname reads.
    const anchor = `/proc/self/fd/${directories[0].fd}`;
    try {
      const [expected, actual] = await Promise.all([
        directories[0].stat({ bigint: true }),
        realpath(anchor),
      ]);
      if (!expected.isDirectory() || actual !== filesystemRoot) throw new Error();
    } catch {
      throw new PublicCompileError(
        "file-safe-read-unsupported",
        safeRelativePath(filePath, rootDir),
      );
    }
    for (const component of components.slice(0, -1)) {
      const parent = directories[directories.length - 1];
      directories.push(await open(`/proc/self/fd/${parent.fd}/${component}`, directoryFlags));
      // The child is now pinned independently; retaining older ancestors would multiply
      // descriptor use when many pages are compiled concurrently.
      await parent.close();
      directories.shift();
    }
    const parent = directories[directories.length - 1];
    handle = await open(`/proc/self/fd/${parent.fd}/${components.at(-1)}`, SAFE_READ_FLAGS);
    if (!(await handle.stat()).isFile()) {
      throw new FileNotRegularError(filePath, rootDir);
    }
    return handle;
  } catch (error) {
    await handle?.close();
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new FileNotRegularError(filePath, rootDir);
    }
    throw error;
  } finally {
    await Promise.all(directories.map((directory) => directory.close()));
  }
}

function isWithinRoot(rootDir: string, filePath: string): boolean {
  const rel = relative(rootDir, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRelativePath(filePath: string, rootDir: string): string | undefined {
  const location = relative(resolve(rootDir), resolve(filePath)).split(sep).join("/");
  return location.length > 0 && !location.startsWith("../") && location !== ".."
    ? location
    : undefined;
}
