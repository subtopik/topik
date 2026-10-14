import { constants } from "node:fs";
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
    process.platform !== "linux" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw new PublicCompileError("file-safe-read-unsupported", safeRelativePath(filePath, rootDir));
  }
  const authoredRoot = resolve(rootDir);
  const authoredFile = resolve(filePath);
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootDir), realpath(filePath)]);
  if (!isWithinRoot(authoredRoot, authoredFile) || !isWithinRoot(canonicalRoot, canonicalFile)) {
    throw new FileOutsideCompilationRootError(filePath, rootDir);
  }
  if (authoredRoot !== canonicalRoot || authoredFile !== canonicalFile) {
    throw new FileNotRegularError(filePath, rootDir);
  }

  // Check before opening so directories and special files (notably FIFOs) cannot block or
  // produce platform-specific read errors. The handle is checked again after opening.
  const initialStat = await lstat(canonicalFile);
  if (!initialStat.isFile()) {
    throw new FileNotRegularError(filePath, rootDir);
  }

  // Anchor every component, including the ancestors of the compilation root. Pathname
  // checks above provide diagnostics only: no later open traverses a mutable ancestor.
  const directories: FileHandle[] = [];
  let handle: FileHandle | undefined;
  try {
    const filesystemRoot = parse(authoredFile).root;
    const components = relative(filesystemRoot, authoredFile).split(sep);
    const directoryFlags = LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    directories.push(await open(filesystemRoot, directoryFlags));
    // Node has no openat API. Linux procfs lets us resolve a single child against a held
    // directory descriptor; O_NOFOLLOW applies to that child, never a multi-part path.
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
