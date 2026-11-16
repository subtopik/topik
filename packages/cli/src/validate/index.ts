import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { boolean, command, positional } from "@drizzle-team/brocli";
import { validateResourceContent, validateResourceGraph, validateResources } from "@topik/core";
import { parseAllDocuments } from "yaml";
import { PublicCliError } from "../errors";
import {
  formatUnreadableResourceFile,
  formatValidationFailure,
  toReadDiagnosticJson,
  toValidationDiagnosticJson,
  type LocatedValidationError,
  type ValidationCheck,
  type ValidationReportJson,
} from "../validation-output";

function parseJson(content: string): unknown {
  try {
    return JSON.parse(stripByteOrderMark(content));
  } catch {
    throw new PublicCliError("resource-json-invalid");
  }
}

function parseJsonl(content: string): unknown[] {
  return stripByteOrderMark(content)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new PublicCliError("resource-jsonl-invalid");
      }
    });
}

/** Accept a leading UTF-8 byte order mark, as the YAML parser already does. */
function stripByteOrderMark(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

function parseYaml(content: string): unknown[] {
  try {
    return parseAllDocuments(content)
      .filter((document) => document.contents !== null)
      .map((document) => {
        if (document.errors.length > 0) {
          throw document.errors[0];
        }
        return document.toJS();
      });
  } catch {
    throw new PublicCliError("resource-yaml-invalid");
  }
}

async function readResourceFile(path: string): Promise<unknown[]> {
  const content = await readFile(path, "utf-8").catch(() => {
    throw new PublicCliError("resource-read-failed");
  });
  const extension = extname(path).toLowerCase();

  switch (extension) {
    case ".json":
      return [parseJson(content)];
    case ".jsonl":
      return parseJsonl(content);
    case ".yaml":
    case ".yml":
      return parseYaml(content);
    default:
      throw new PublicCliError("resource-format-unsupported");
  }
}

const RESOURCE_EXTENSIONS = new Set([".json", ".jsonl", ".yaml", ".yml"]);

/** A parsed resource and the target-relative file it was read from. */
export interface LoadedResource {
  file: string;
  resource: unknown;
}

async function readLocatedResourceFile(path: string, file: string): Promise<LoadedResource[]> {
  return (await readResourceFile(path)).map((resource) => ({ file, resource }));
}

/** A resource file in a directory tree that could not be read or parsed. */
export interface UnreadableResourceFile {
  file: string;
  error: unknown;
}

export interface LoadedResourceTree {
  resources: LoadedResource[];
  unreadable: UnreadableResourceFile[];
}

async function readDirectoryEntries(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true }).catch(() => {
    throw new PublicCliError("resource-read-failed");
  });
}

/**
 * A `topik compile` output tree holds compilation descriptors (`materialization.json`,
 * `semantic.json`) beside its `resources/` envelopes; only the envelopes are resources.
 */
function isCompilationOutputTree(entries: readonly Dirent[]): boolean {
  const names = new Map(entries.map((entry) => [entry.name, entry]));
  return (
    names.get("materialization.json")?.isFile() === true &&
    names.get("semantic.json")?.isFile() === true &&
    names.get("resources")?.isDirectory() === true
  );
}

/** Collect resource files below `root`, skipping `node_modules` and dot-directories. */
async function collectResourceFiles(
  root: string,
  relativeDir: string,
  entries: readonly Dirent[],
  files: string[],
): Promise<void> {
  for (const entry of entries) {
    const relativePath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const children = await readDirectoryEntries(join(root, relativePath));
      await collectResourceFiles(root, relativePath, children, files);
      continue;
    }
    if (entry.isFile() && RESOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(relativePath);
    }
  }
}

/**
 * Load resources from a file, a directory tree, or a `topik compile` output directory.
 * A single file target fails on its own error; in a directory, each file that cannot
 * be read or parsed is recorded and the remaining files are still loaded.
 */
export async function loadLocatedResources(path: string): Promise<LoadedResourceTree> {
  const info = await stat(path).catch(() => {
    throw new PublicCliError("resource-access-failed");
  });

  if (info.isFile()) {
    return { resources: await readLocatedResourceFile(path, basename(path)), unreadable: [] };
  }

  const rootEntries = await readDirectoryEntries(path);
  const files: string[] = [];
  if (isCompilationOutputTree(rootEntries)) {
    const resourceEntries = await readDirectoryEntries(join(path, "resources"));
    await collectResourceFiles(path, "resources", resourceEntries, files);
  } else {
    await collectResourceFiles(path, "", rootEntries, files);
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  const results = await Promise.all(
    files.map((file) =>
      readLocatedResourceFile(join(path, ...file.split("/")), file).then(
        (resources) => ({ resources }),
        (error: unknown) => ({ unreadable: { file, error } }),
      ),
    ),
  );
  return {
    resources: results.flatMap((result) => ("resources" in result ? result.resources : [])),
    unreadable: results.flatMap((result) => ("unreadable" in result ? [result.unreadable] : [])),
  };
}

/** Print the `--json` report as one JSON document on stdout. */
function printReport(report: Omit<ValidationReportJson, "version" | "valid">): void {
  const result: ValidationReportJson = {
    version: 1,
    valid: report.diagnostics.length === 0,
    resources: report.resources,
    checks: report.checks,
    diagnostics: report.diagnostics,
  };
  console.log(JSON.stringify(result, null, 2));
}

export const validate = command({
  name: "validate",
  desc: "Validate Topik resource files in JSON, JSONL, or YAML format against schemas",
  options: {
    path: positional("path")
      .desc("Resource file, directory, or compilation output to validate")
      .required(),
    graph: boolean("graph")
      .desc(
        "Also check the resources as one complete set: unique type/name and resolvable references",
      )
      .default(false),
    content: boolean("content")
      .desc("Also check the Topik content of CoursePage, Guide, and WikiPage resources")
      .default(false),
    json: boolean("json").desc("Print machine-readable results on stdout").default(false),
  },
  handler: async (options) => {
    const target = resolve(options.path);
    const checks: ValidationCheck[] = ["schema"];
    if (options.graph === true) checks.push("graph");
    if (options.content === true) checks.push("content");
    const json = options.json === true;

    let tree: LoadedResourceTree;
    try {
      tree = await loadLocatedResources(target);
    } catch (error) {
      if (json)
        printReport({
          resources: 0,
          checks,
          diagnostics: [toReadDiagnosticJson(undefined, error)],
        });
      throw error;
    }
    const { resources: loaded, unreadable } = tree;

    const located: {
      index: number;
      check: Exclude<ValidationCheck, "read">;
      error: LocatedValidationError;
    }[] = [];
    loaded.forEach(({ file, resource }, index) => {
      for (const error of validateResources([resource]).errors)
        located.push({ index, check: "schema", error: { ...error, file } });
      if (options.content === true)
        for (const error of validateResourceContent([resource]).errors)
          located.push({ index, check: "content", error: { ...error, file } });
    });
    if (options.graph === true) {
      for (const { index, ...error } of validateResourceGraph(loaded.map((item) => item.resource))
        .errors)
        located.push({ index, check: "graph", error: { ...error, file: loaded[index]?.file } });
    }
    // Stable: each resource's schema, content, then graph errors, in file order.
    located.sort((left, right) => left.index - right.index);
    const errors = located.map((item) => item.error);

    if (json) {
      printReport({
        resources: loaded.length,
        checks,
        diagnostics: [
          ...unreadable.map(({ file, error }) => toReadDiagnosticJson(file, error)),
          ...located.map(({ check, error }) => toValidationDiagnosticJson(error, check)),
        ],
      });
      if (errors.length > 0 || unreadable.length > 0)
        throw new PublicCliError("resource-validation-failed");
      return;
    }

    if (loaded.length === 0 && unreadable.length === 0) {
      console.log("No resource files found.");
      return;
    }

    for (const { file, error } of unreadable) {
      console.error(formatUnreadableResourceFile(file, error));
    }

    if (errors.length === 0 && unreadable.length === 0) {
      console.log(`Validated ${loaded.length} resources`);
      return;
    }
    if (errors.length > 0) {
      console.error(formatValidationFailure(errors, loaded.length, "validating resources"));
    }
    if (unreadable.length > 0) {
      console.error(
        `${unreadable.length} resource file(s) could not be read or parsed; ` +
          `${loaded.length} resources were validated`,
      );
    }
    throw new PublicCliError("resource-validation-failed");
  },
});
