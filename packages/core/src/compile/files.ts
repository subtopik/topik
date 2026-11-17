import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
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
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootDir), realpath(filePath)]);
  } catch (error) {
    // A non-directory or looping ancestor component cannot name a regular input file.
    if (isNotRegularPathError(error)) throw new FileNotRegularError(filePath, rootDir);
    // A dangling symlink is an entry that exists but is not a regular file.
    if (isMissingPathError(error) && (await isSymbolicLink(filePath))) {
      throw new FileNotRegularError(filePath, rootDir);
    }
    throw error;
  }
  if (!isWithinRoot(canonicalRoot, canonicalFile)) {
    throw new FileOutsideCompilationRootError(filePath, rootDir);
  }
  // Canonical aliases above the source root (such as macOS /var or a symlinked /home) are
  // accepted, like the manifest and configuration reader, but a symlinked root or a path
  // redirected within it is rejected. Keep exact spelling below the canonical root: Windows
  // path.relative folds case even when the filesystem contains distinct case-sensitive entries.
  const expectedFile = resolve(canonicalRoot, relative(authoredRoot, authoredFile));
  if (
    (expectedFile !== canonicalFile &&
      !(await differsOnlyInUnicodeForm(authoredRoot, authoredFile, expectedFile, canonicalFile))) ||
    (process.platform === "linux"
      ? // The root itself is not a link when it keeps its name under its canonical parent.
        canonicalRoot !== join(await realpath(dirname(authoredRoot)), basename(authoredRoot))
      : !(await lstat(authoredRoot)).isDirectory())
  ) {
    throw new FileNotRegularError(filePath, rootDir);
  }

  // Check before opening so directories and special files (notably FIFOs) cannot block or
  // produce platform-specific read errors. The handle is checked again after opening.
  const initialStat = await lstat(canonicalFile, { bigint: true });
  if (!initialStat.isFile()) {
    throw new FileNotRegularError(filePath, rootDir);
  }

  // Linux anchors the canonical path, which resolves the root's ancestors once up front;
  // every component is then opened without following links.
  return process.platform === "linux"
    ? openAnchoredLinuxFile(canonicalFile, filePath, rootDir)
    : openPortableFile(filePath, rootDir, canonicalFile, initialStat);
}

/**
 * HFS+ (and APFS for names created decomposed) resolves an NFC-authored name to its stored
 * NFD spelling. Accept that difference only — Unicode form, never case — and only when no
 * authored component below the root is a link and the authored name is the resolved entry.
 * Without those checks a link from one spelling to a distinct sibling with the other spelling
 * (possible on normalization-sensitive filesystems) would pass the relaxed comparison.
 */
async function differsOnlyInUnicodeForm(
  authoredRoot: string,
  authoredFile: string,
  expectedFile: string,
  canonicalFile: string,
): Promise<boolean> {
  if (expectedFile.normalize("NFC") !== canonicalFile.normalize("NFC")) return false;
  try {
    let current = authoredRoot;
    let entry: BigIntStats | undefined;
    for (const component of relative(authoredRoot, authoredFile).split(sep)) {
      current = join(current, component);
      entry = await lstat(current, { bigint: true });
      if (entry.isSymbolicLink()) return false;
    }
    const resolved = await lstat(canonicalFile, { bigint: true });
    return entry !== undefined && entry.dev === resolved.dev && entry.ino === resolved.ino;
  } catch {
    return false;
  }
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
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
    if (isNotRegularPathError(error)) {
      throw new FileNotRegularError(filePath, rootDir);
    }
    throw error;
  }
}

async function openAnchoredLinuxFile(
  anchoredPath: string,
  filePath: string,
  rootDir: string,
): Promise<FileHandle> {
  // Anchor every component, including the ancestors of the compilation root. Pathname
  // checks above provide diagnostics only: no later open traverses a mutable ancestor.
  const directories: FileHandle[] = [];
  let handle: FileHandle | undefined;
  try {
    const filesystemRoot = parse(anchoredPath).root;
    const components = relative(filesystemRoot, anchoredPath).split(sep);
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
    if (isNotRegularPathError(error)) {
      throw new FileNotRegularError(filePath, rootDir);
    }
    throw error;
  } finally {
    await Promise.all(directories.map((directory) => directory.close()));
  }
}

function isNotRegularPathError(error: unknown): boolean {
  return ["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/**
 * Decode authored Markdown strictly so invalid bytes fail visibly instead of becoming
 * U+FFFD. `location` is the safe compilation-relative path reported on failure.
 */
export function decodeUtf8Document(bytes: Uint8Array, location: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PublicCompileError("document-encoding-invalid", location);
  }
}

/**
 * Map items with at most `limit` operations in flight, keeping results in input order.
 * Bounds descriptor use when a compilation reads many files. Items start in order and
 * no new item starts after a failure, so the reported failure is always the earliest
 * failing item regardless of completion timing.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failedIndex = Number.POSITIVE_INFINITY;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failedIndex === Number.POSITIVE_INFINITY && next < items.length) {
      const index = next++;
      try {
        results[index] = await operation(items[index], index);
      } catch (error) {
        if (index < failedIndex) {
          failedIndex = index;
          failure = error;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  if (failedIndex !== Number.POSITIVE_INFINITY) throw failure;
  return results;
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

/** @internal Keep the paths that name a regular file below `dir`; a link is not followed. */
export async function existingDocuments(dir: string, paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    const info = await lstat(join(dir, path)).catch(() => undefined);
    if (info?.isFile()) found.push(path);
  }
  return found;
}
