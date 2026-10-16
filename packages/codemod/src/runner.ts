import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { rewriteTopikNavigationReferences } from "@topik/content";
import { pathExists, publishMigration, type MigrationEdit } from "./migration";
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
  changed: boolean;
  error?: string;
}

export interface RunSummary {
  files: FileResult[];
  filesChanged: number;
  warnings: number;
}

interface FilePlan extends MigrationEdit {
  result: FileResult;
}

export async function runMintlify(options: RunOptions): Promise<RunSummary> {
  const root = resolve(options.dir);
  const files: FileResult[] = [];
  const plans: FilePlan[] = [];
  let opaqueSource = false;
  for await (const path of walk(root)) {
    if (!path.endsWith(".mdx") && !path.endsWith(".md")) continue;
    const result: FileResult = { relativePath: relative(root, path), warnings: [], changed: false };
    files.push(result);
    try {
      const source = await readFile(path, "utf8");
      const transformed = transformMintlify(source);
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
    let reason = opaqueSource ? "some source files could not be safely inspected" : undefined;
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
      // An untouched source may link to any candidate. Keep extensions across the
      // run, while still applying independent, supported component conversions.
      for (const plan of plans) {
        if (plan.destination === plan.path) continue;
        plan.destination = plan.path;
        plan.result.warnings.push({
          line: 1,
          column: 1,
          message: `Keeping .mdx extensions because ${reason}; fix the reported files and rerun`,
        });
      }
    } else {
      for (const [plan, content] of rewritten) plan.content = content;
    }
  }

  const edits = plans.filter(
    (plan) => plan.source !== plan.content || plan.path !== plan.destination,
  );
  for (const plan of edits) {
    plan.result.changed = true;
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
        delete plan.result.newRelativePath;
        const failure = `Migration failed: ${error instanceof Error ? error.message : String(error)}`;
        plan.result.error = plan.result.error ? `${plan.result.error}; ${failure}` : failure;
      }
    }
  }
  return {
    files,
    filesChanged: files.filter((file) => file.changed).length,
    warnings: files.reduce((total, file) => total + file.warnings.length, 0),
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
  if (!decoded.endsWith(".mdx")) return;
  const target = decoded.startsWith("/")
    ? resolve(root, `.${decoded}`)
    : resolve(dirname(sourcePath), decoded);
  if (!renames.has(target)) return;
  // Remove just the final x, retaining the spelling of the path, query, and hash.
  return pathname.replace(/(?:x|%78)$/, "") + (end < 0 ? "" : href.slice(end));
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
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
