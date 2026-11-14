import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { rewriteTopikNavigationReferences } from "@topik/content";
import { pathExists, publishMigration, STAGING_PREFIX, type MigrationEdit } from "./migration";
import { transformMintlify, type TransformWarning } from "./transforms/mintlify";

export interface RunOptions {
  dir: string;
  dryRun: boolean;
  keepExtension: boolean;
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
}

export interface RunSummary {
  files: FileResult[];
  filesChanged: number;
  warnings: number;
  /** Run-level messages that do not belong to a single file. */
  notices: string[];
}

interface FilePlan extends MigrationEdit {
  result: FileResult;
}

export async function runMintlify(options: RunOptions): Promise<RunSummary> {
  const root = resolve(options.dir);
  const files: FileResult[] = [];
  const plans: FilePlan[] = [];
  const notices: string[] = [];
  const staging: string[] = [];
  let opaqueSource = false;
  for await (const path of walk(root, staging)) {
    if (!path.endsWith(".mdx") && !path.endsWith(".md")) continue;
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
      const transformed = transformMintlify(source, { mdx: path.endsWith(".mdx") });
      result.warnings = transformed.warnings;
      const plan: FilePlan = {
        path,
        destination: path,
        source,
        content: transformed.content,
        result,
      };
      plans.push(plan);
      if (result.warnings.length) {
        opaqueSource = true;
      } else if (!options.keepExtension && path.endsWith(".mdx")) {
        const destination = path.slice(0, -4) + ".md";
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
    let reason = opaqueSource
      ? "files kept unchanged with warnings or errors may link to renamed pages"
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
        `Kept .mdx extensions on ${kept} file(s) because ${reason}; fix the reported files and rerun to rename them`,
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
  }
  if (!options.dryRun && edits.length) {
    try {
      const cleanupWarnings = await publishMigration(edits);
      for (const message of cleanupWarnings)
        edits[0].result.warnings.push({ line: 1, column: 1, message });
    } catch (error) {
      for (const plan of edits) {
        plan.result.changed = false;
        plan.result.contentChanged = false;
        delete plan.result.newRelativePath;
        const failure = `Migration failed: ${error instanceof Error ? error.message : String(error)}`;
        plan.result.error = plan.result.error ? `${plan.result.error}; ${failure}` : failure;
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
  return {
    files,
    filesChanged: files.filter((file) => file.changed).length,
    warnings: files.reduce((total, file) => total + file.warnings.length, 0),
    notices,
  };
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
  if (!decoded.replace(/\/+$/, "").endsWith(".mdx")) return;
  const target = decoded.startsWith("/")
    ? resolve(root, `.${decoded}`)
    : resolve(dirname(sourcePath), decoded);
  if (!renames.has(target)) return;
  // Remove just the final x, retaining the spelling of the path, query, and hash.
  return pathname.replace(/(?:x|%78)((?:\/|%2[fF])*)$/, "$1") + (end < 0 ? "" : href.slice(end));
}

async function* walk(dir: string, staging: string[]): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX))
      staging.push(join(dir, entry.name));
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, staging);
    else if (entry.isFile()) yield full;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
