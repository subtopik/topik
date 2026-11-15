import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { rewriteTopikNavigationReferences } from "@topik/content";
import { unifiedDiff } from "./diff";
import { pathExists, publishMigration, STAGING_PREFIX, type MigrationEdit } from "./migration";
import {
  convertMintlifyNavigation,
  MINTLIFY_CONFIG_FILES,
  WIKI_CONFIG_FILES,
  type MintlifyConfigFile,
} from "./navigation";
import { transformMintlify, type TransformWarning } from "./transforms/mintlify";

export interface RunOptions {
  /** A content directory, or a single `.md` or `.mdx` file. */
  dir: string;
  dryRun: boolean;
  keepExtension: boolean;
  /** Attach a unified diff to each changed file and write nothing, as in a dry run. */
  diff?: boolean;
}

export interface NavigationResult {
  /** The Mintlify configuration that was read. */
  source: MintlifyConfigFile;
  /** The wiki configuration that is (or would be) written. */
  output: "wiki.yaml";
  /** `wiki.yaml` is (or would be) written. */
  changed: boolean;
  warnings: string[];
  diff?: string;
  error?: string;
}

export interface FileResult {
  relativePath: string;
  newRelativePath?: string;
  warnings: TransformWarning[];
  /** The file is (or would be) rewritten or renamed. */
  changed: boolean;
  /** The file's content is (or would be) rewritten, as opposed to only renamed. */
  contentChanged: boolean;
  error?: string;
  /** The unified diff of the change, when requested. */
  diff?: string;
}

export interface RunSummary {
  files: FileResult[];
  /** The `docs.json` or `mint.json` navigation conversion, when a directory has one. */
  navigation?: NavigationResult;
  filesChanged: number;
  warnings: number;
  /** Run-level messages that do not belong to a single file. */
  notices: string[];
}

interface FilePlan extends MigrationEdit {
  result: FileResult;
}

export async function runMintlify(options: RunOptions): Promise<RunSummary> {
  const input = resolve(options.dir);
  // A single file is migrated on its own; its directory is not walked.
  const single = !(await isDirectory(input));
  const root = single ? dirname(input) : input;
  const write = !options.dryRun && !options.diff;
  const files: FileResult[] = [];
  const plans: FilePlan[] = [];
  const notices: string[] = [];
  const staging: string[] = [];
  const symlinks: string[] = [];
  let opaqueSource = false;
  const sources = single ? selectFile(input, staging, symlinks) : walk(root, staging, symlinks);
  for await (const path of sources) {
    const mdx = isMdx(path);
    if (!mdx && !isMarkdown(path)) continue;
    const result: FileResult = {
      relativePath: relative(root, path),
      warnings: [],
      changed: false,
      contentChanged: false,
    };
    files.push(result);
    try {
      const bytes = await readFile(path);
      const source = bytes.toString("utf8");
      if (!Buffer.from(source, "utf8").equals(bytes)) {
        result.warnings.push({
          line: 1,
          column: 1,
          message: "File is not valid UTF-8; source kept",
        });
        opaqueSource = true;
        continue;
      }
      // MDX-only syntax (ESM, expressions) would render as prose once renamed to .md.
      const transformed = transformMintlify(source, { mdx });
      result.warnings = transformed.warnings;
      const plan: FilePlan = {
        path,
        destination: path,
        source,
        content: transformed.content,
        result,
      };
      plans.push(plan);
      // Warnings on a converted file are notes (such as a dropped icon), not refusals.
      if (!transformed.changed && result.warnings.length) {
        opaqueSource = true;
      } else if (!options.keepExtension && mdx) {
        // Drop the final x, keeping the spelling of the rest of the extension.
        const destination = path.slice(0, -1);
        if (await pathExists(destination)) {
          result.error = `Skipping rename: destination ${relative(root, destination)} already exists`;
        } else {
          plan.destination = destination;
        }
      }
    } catch (error) {
      opaqueSource = true;
      result.error = error instanceof Error ? error.message : String(error);
    }
  }

  const renames = new Set(
    plans.filter((plan) => plan.path !== plan.destination).map((plan) => plan.path),
  );
  if (renames.size) {
    let reason = single
      ? "pages outside the selected file were not inspected and may link to it"
      : opaqueSource
        ? "files kept unchanged with warnings or errors may link to renamed pages"
        : symlinks.length
          ? "pages behind symbolic links that were not followed may link to renamed pages"
          : undefined;
    const rewritten = new Map<FilePlan, string>();
    if (!reason) {
      for (const plan of plans) {
        const result = rewriteTopikNavigationReferences(plan.content, ({ href }) =>
          renamedHref(href, plan.path, root, renames),
        );
        if (!result.ok) {
          reason = `navigation in ${plan.result.relativePath} could not be safely rewritten`;
          break;
        }
        rewritten.set(plan, result.content);
      }
    }
    if (reason) {
      // An untouched source may link to any candidate, and its links cannot be
      // rewritten, so renaming any page could break them. Keep extensions across
      // the run, while still applying independent, supported component conversions.
      let kept = 0;
      for (const plan of plans) {
        if (plan.destination === plan.path) continue;
        plan.destination = plan.path;
        kept++;
      }
      notices.push(
        `Kept .mdx extensions on ${kept} file(s) because ${reason}; ${single ? "run the codemod on the directory to rename it" : "fix the reported files and rerun to rename them"}`,
      );
    } else {
      for (const [plan, content] of rewritten) plan.content = content;
    }
  }

  const edits = plans.filter(
    (plan) => plan.source !== plan.content || plan.path !== plan.destination,
  );
  for (const plan of edits) {
    plan.result.changed = true;
    plan.result.contentChanged = plan.source !== plan.content;
    if (plan.path !== plan.destination)
      plan.result.newRelativePath = relative(root, plan.destination);
    if (options.diff)
      plan.result.diff = unifiedDiff(
        toPosix(plan.result.relativePath),
        toPosix(plan.result.newRelativePath ?? plan.result.relativePath),
        plan.source,
        plan.content,
      );
  }
  const navigation = single ? undefined : await planNavigation(root, files, notices, options);
  let failed = false;
  if (write && edits.length) {
    try {
      const cleanupWarnings = await publishMigration(edits);
      for (const message of cleanupWarnings)
        edits[0].result.warnings.push({ line: 1, column: 1, message });
    } catch (error) {
      failed = true;
      for (const plan of edits) {
        plan.result.changed = false;
        plan.result.contentChanged = false;
        delete plan.result.newRelativePath;
        const failure = `Migration failed: ${error instanceof Error ? error.message : String(error)}`;
        plan.result.error = plan.result.error ? `${plan.result.error}; ${failure}` : failure;
      }
    }
  }
  if (navigation?.yaml !== undefined) {
    const { result } = navigation;
    if (failed) {
      result.changed = false;
      result.error = "Not written because the page migration failed";
    } else if (write) {
      try {
        // Exclusive creation: an existing wiki.yaml is never replaced.
        await writeFile(join(root, result.output), navigation.yaml, { flag: "wx" });
      } catch (error) {
        result.changed = false;
        result.error =
          (error as NodeJS.ErrnoException).code === "EEXIST"
            ? `Kept the ${result.output} created during the migration`
            : `Unable to write ${result.output}`;
      }
    }
  }
  // Walks skip hidden directories, including staging left by an interrupted run.
  notices.unshift(
    ...staging.map(
      (directory) =>
        `Found ${relative(root, directory)} from an interrupted or failed run. If a page next to it is missing or incomplete, restore it from "original" (the pre-migration source; "candidate" is the converted version), then delete the directory`,
    ),
  );
  if (symlinks.length)
    notices.push(
      `Skipped ${symlinks.length} symbolic link(s), which are not followed: ${symlinks.map((path) => relative(root, path)).join(", ")}`,
    );
  return {
    files,
    ...(navigation ? { navigation: navigation.result } : {}),
    filesChanged: files.filter((file) => file.changed).length,
    warnings:
      files.reduce((total, file) => total + file.warnings.length, 0) +
      (navigation?.result.warnings.length ?? 0),
    notices,
  };
}

/** Plan a `wiki.yaml` from the directory's Mintlify navigation, never replacing a wiki configuration. */
async function planNavigation(
  root: string,
  files: readonly FileResult[],
  notices: string[],
  options: RunOptions,
): Promise<{ result: NavigationResult; yaml?: string } | undefined> {
  const found: MintlifyConfigFile[] = [];
  for (const name of MINTLIFY_CONFIG_FILES) if (await isFile(join(root, name))) found.push(name);
  const source = found[0];
  if (source === undefined) return;
  if (found.length > 1) notices.push(`Read ${source} and ignored the legacy ${found[1]}`);
  for (const name of WIKI_CONFIG_FILES)
    if (await pathExists(join(root, name))) {
      notices.push(`Kept the existing ${name}; navigation in ${source} was not converted`);
      return;
    }
  const result: NavigationResult = { source, output: "wiki.yaml", changed: false, warnings: [] };
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(root, source), "utf8"));
  } catch {
    result.error = `Unable to read ${source} as JSON`;
    return { result };
  }
  // Pages as the compiler will find them after the migration: lowercase .md or .mdx files.
  const pages = new Set(
    files.flatMap((file) => {
      const match = /^(.+)\.mdx?$/.exec(toPosix(file.newRelativePath ?? file.relativePath));
      return match ? [match[1]] : [];
    }),
  );
  const converted = convertMintlifyNavigation(source, config, pages);
  result.warnings = converted.warnings;
  if (converted.yaml === undefined) return { result };
  result.changed = true;
  if (options.diff) result.diff = unifiedDiff(null, result.output, "", converted.yaml);
  return { result, yaml: converted.yaml };
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** Yield a single selected page, reporting staging left next to it by an interrupted run. */
async function* selectFile(
  path: string,
  staging: string[],
  symlinks: string[],
): AsyncGenerator<string> {
  const dir = dirname(path);
  for (const entry of await readdir(dir, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX))
      staging.push(join(dir, entry.name));
  // As in a directory walk, a symbolic link is reported and not followed.
  if ((await lstat(path)).isSymbolicLink()) symlinks.push(path);
  else yield path;
}

/**
 * Whether a path names a directory or a regular `.md` or `.mdx` file the codemod can migrate.
 * A directory argument may be a symbolic link, as before single-file input existed; links
 * inside it are still not followed. A file argument must not be a link, because publishing
 * replaces the path itself.
 */
export async function isMigrationInput(path: string): Promise<boolean> {
  try {
    if (await isDirectory(path)) return true;
    const info = await lstat(path);
    return info.isFile() && (isMdx(path) || isMarkdown(path));
  } catch {
    return false;
  }
}

function renamedHref(
  href: string,
  sourcePath: string,
  root: string,
  renames: ReadonlySet<string>,
): string | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#|\?)/i.test(href)) return;
  const end = href.search(/[?#]/);
  const pathname = end < 0 ? href : href.slice(0, end);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return;
  }
  // The compiler also accepts explicit Markdown filenames with trailing separators.
  if (!isMdx(decoded.replace(/\/+$/, ""))) return;
  const target = decoded.startsWith("/")
    ? resolve(root, `.${decoded}`)
    : resolve(dirname(sourcePath), decoded);
  if (!renames.has(target)) return;
  // Remove just the final x, retaining the spelling of the path, query, and hash.
  return (
    pathname.replace(/(?:[xX]|%78|%58)((?:\/|%2[fF])*)$/, "$1") + (end < 0 ? "" : href.slice(end))
  );
}

function isMdx(path: string): boolean {
  return path.toLowerCase().endsWith(".mdx");
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

async function* walk(dir: string, staging: string[], symlinks: string[]): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX))
      staging.push(join(dir, entry.name));
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, staging, symlinks);
    else if (entry.isFile()) yield full;
    // Symbolic links are not followed; report pages and directories they hide.
    else if (
      entry.isSymbolicLink() &&
      (isMdx(entry.name) || isMarkdown(entry.name) || (await isDirectory(full)))
    )
      symlinks.push(full);
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
