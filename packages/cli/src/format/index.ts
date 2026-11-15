import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { boolean, command, positional } from "@drizzle-team/brocli";
import { formatTopikContent, sanitizeTopikDiagnosticFile } from "@topik/content";
import { readPortableAssetFile, type FileSafety } from "@topik/core";
import { printDiagnostics } from "../diagnostics";
import { PublicCliError } from "../errors";
import { fileSafetyOption, notePortableReads } from "../file-safety";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

/** A Markdown file to format: the root its reads are anchored to and its path below it. */
export interface FormatTarget {
  root: string;
  /** Root-relative path with `/` separators. */
  path: string;
  /** Sanitized label printed for the file. */
  label: string;
}

/**
 * Resolve the command argument to Markdown files. A file must be `.md` or `.mdx`; a directory
 * is walked for those files, skipping `node_modules`, dot-directories below it and symbolic links.
 */
export async function discoverFormatTargets(
  argument: string,
  cwd = process.cwd(),
): Promise<FormatTarget[]> {
  const absolute = resolve(cwd, argument);
  const info = await lstat(absolute).catch(() => {
    throw new PublicCliError("format-target-access-failed");
  });
  if (info.isFile()) {
    if (!isMarkdownFile(absolute)) throw new PublicCliError("format-target-unsupported");
    const path = basename(absolute);
    return [{ root: dirname(absolute), path, label: displayLabel(path) }];
  }
  if (!info.isDirectory()) throw new PublicCliError("format-target-unsupported");
  const files: string[] = [];
  await collectMarkdownFiles(absolute, "", files);
  return files.map((path) => ({
    root: absolute,
    path,
    label: displayLabel(path),
  }));
}

function isMarkdownFile(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
}

async function collectMarkdownFiles(
  root: string,
  relativeDir: string,
  files: string[],
): Promise<void> {
  const entries: Dirent[] = await readdir(
    relativeDir.length === 0 ? root : join(root, ...relativeDir.split("/")),
    { withFileTypes: true },
  ).catch(() => {
    throw new PublicCliError("format-target-access-failed");
  });
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const path = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await collectMarkdownFiles(root, path, files);
    } else if (entry.isFile() && isMarkdownFile(entry.name)) {
      files.push(path);
    }
  }
}

/** Target-relative labels, as `topik validate` prints them, never absolute paths. */
function displayLabel(path: string): string {
  return sanitizeTopikDiagnosticFile(path) ?? "Markdown file";
}

export type FormatFileOutcome = "unchanged" | "changed" | "invalid" | "unreadable";

/**
 * Format one file. With `write`, a changed file is replaced atomically: the new content goes to
 * an exclusively created sibling, and is renamed over the original only if the original still
 * holds the bytes that were formatted. A file that does not compile cleanly is left untouched.
 */
export async function formatFile(
  target: FormatTarget,
  options: { write: boolean; fileSafety: FileSafety },
): Promise<FormatFileOutcome> {
  const read = await readPortableAssetFile({
    root: target.root,
    path: target.path,
    fileSafety: options.fileSafety,
  });
  if (!read.ok || read.value.bytes === undefined) return "unreadable";
  const bytes = read.value.bytes;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "unreadable";
  }

  const result = formatTopikContent(source, { file: target.label });
  if (!result.ok) {
    printDiagnostics(result.diagnostics);
    return "invalid";
  }
  if (result.formatted === source) return "unchanged";
  if (!options.write) return "changed";
  return (await replaceFile(target, bytes, Buffer.from(result.formatted, "utf8")))
    ? "changed"
    : "unreadable";
}

const READ_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
  (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
const CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
const DIRECTORY_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0) |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

/**
 * Replace `target` with `next` if it still holds `expected`. On Linux every step goes through a
 * descriptor of the file's directory opened component by component without following links
 * (`/proc/self/fd`), as `topik compile` publishes output; elsewhere the same steps run by path,
 * which is the portable file safety the notice describes. Returns false if the file changed,
 * became a link or could not be replaced; the original is then left as it is.
 */
async function replaceFile(
  target: FormatTarget,
  expected: Uint8Array,
  next: Uint8Array,
): Promise<boolean> {
  const components = target.path.split("/");
  const name = components.pop() ?? "";
  const anchored = process.platform === "linux";
  let directory: FileHandle | undefined;
  let temporary: string | undefined;
  try {
    let parent: string;
    if (anchored) {
      directory = await openAnchoredDirectory(target.root, components);
      parent = `/proc/self/fd/${directory.fd}`;
    } else {
      parent = join(target.root, ...components);
      if (!(await lstat(parent)).isDirectory()) return false;
    }
    const file = join(parent, name);
    const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1) return false;
    if (!sameBytes(await readNoFollow(file), expected)) return false;

    temporary = join(parent, `.${name}.topik-format-${randomUUID()}`);
    const output = await open(temporary, CREATE_FLAGS, before.mode & 0o666);
    try {
      // The creation mode is filtered by the umask; restore the original read/write bits.
      // Execute bits never apply: the reader refuses executable files.
      await output.chmod(before.mode & 0o666);
      await output.writeFile(next);
      await output.sync();
    } finally {
      await output.close();
    }

    const after = await lstat(file);
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      return false;
    }
    await rename(temporary, file);
    temporary = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
    await directory?.close().catch(() => undefined);
  }
}

async function openAnchoredDirectory(root: string, components: string[]): Promise<FileHandle> {
  let current = await open(root, DIRECTORY_FLAGS);
  try {
    for (const component of components) {
      const child = await open(`/proc/self/fd/${current.fd}/${component}`, DIRECTORY_FLAGS);
      await current.close();
      current = child;
    }
    if (!(await current.stat()).isDirectory()) throw new Error("Not a directory");
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function readNoFollow(path: string): Promise<Buffer> {
  const handle = await open(path, READ_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Not a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

export const format = command({
  name: "format",
  desc: "Format Topik Markdown files in place",
  options: {
    path: positional("path").desc("Markdown file or directory to format").default("."),
    check: boolean("check")
      .desc("List files that are not formatted and exit 1 instead of writing")
      .default(false),
    fileSafety: fileSafetyOption(),
  },
  handler: async (options) => {
    await runFormat(options.path, { check: options.check, fileSafety: options.fileSafety });
  },
});

/** @internal Run `topik format` on a Markdown file or directory. */
export async function runFormat(
  path: string,
  options: { check: boolean; fileSafety: FileSafety },
): Promise<void> {
  notePortableReads(options.fileSafety);
  // Refuse before discovery, as project commands do: no read could succeed on this platform.
  if (process.platform !== "linux" && options.fileSafety === "anchored") {
    throw new PublicCliError("project-platform-unsupported");
  }
  const targets = await discoverFormatTargets(path);
  if (targets.length === 0) {
    console.log("No Markdown files found.");
    return;
  }

  let changed = 0;
  let failed = 0;
  for (const target of targets) {
    const outcome = await formatFile(target, {
      write: !options.check,
      fileSafety: options.fileSafety,
    });
    if (outcome === "changed") {
      changed++;
      console.log(target.label);
    } else if (outcome === "unreadable") {
      failed++;
      console.error(`${target.label}: Markdown file could not be read or replaced safely.`);
    } else if (outcome === "invalid") {
      failed++;
    }
  }

  const total = targets.length;
  if (failed > 0) console.error(`${failed} of ${total} file(s) could not be formatted`);
  if (options.check && changed > 0) console.error(`${changed} of ${total} file(s) need formatting`);
  if (failed > 0) throw new PublicCliError("format-failed");
  if (options.check && changed > 0) throw new PublicCliError("format-check-failed");
  console.log(
    options.check
      ? `All ${total} file(s) are formatted`
      : `Formatted ${changed} of ${total} file(s)`,
  );
}
