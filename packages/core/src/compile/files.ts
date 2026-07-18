import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const SAFE_READ_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
  (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);

export class FileOutsideCompilationRootError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly rootDir: string,
  ) {
    super(`File ${filePath} resolves outside the compilation directory ${rootDir}`);
    this.name = "FileOutsideCompilationRootError";
  }
}

export class FileNotRegularError extends Error {
  constructor(public readonly filePath: string) {
    super(`File ${filePath} is not a regular file`);
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
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootDir), realpath(filePath)]);
  if (!isWithinRoot(canonicalRoot, canonicalFile)) {
    throw new FileOutsideCompilationRootError(filePath, rootDir);
  }

  // Check before opening so directories and special files (notably FIFOs) cannot block or
  // produce platform-specific read errors. The handle is checked again after opening.
  const initialStat = await lstat(canonicalFile);
  if (!initialStat.isFile()) {
    throw new FileNotRegularError(filePath);
  }

  // On platforms that expose O_NOFOLLOW, reject a replacement final-component symlink.
  // The regular-file check and read operate on the same handle, reducing check/read races.
  const handle = await open(canonicalFile, SAFE_READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new FileNotRegularError(filePath);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function isWithinRoot(rootDir: string, filePath: string): boolean {
  const rel = relative(rootDir, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
