import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { command, positional } from "@drizzle-team/brocli";
import { validateResources } from "@topik/core";
import { parseAllDocuments } from "yaml";
import { PublicCliError } from "../errors";
import { formatUnreadableResourceFile, formatValidationFailure } from "../validation-output";

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

export const validate = command({
  name: "validate",
  desc: "Validate Topik resource files in JSON, JSONL, or YAML format against schemas",
  options: {
    path: positional("path")
      .desc("Resource file, directory, or compilation output to validate")
      .required(),
  },
  handler: async (options) => {
    const target = resolve(options.path);
    const { resources: loaded, unreadable } = await loadLocatedResources(target);

    if (loaded.length === 0 && unreadable.length === 0) {
      console.log("No resource files found.");
      return;
    }

    for (const { file, error } of unreadable) {
      console.error(formatUnreadableResourceFile(file, error));
    }

    const errors = loaded.flatMap(({ file, resource }) =>
      validateResources([resource]).errors.map((error) => ({ ...error, file })),
    );

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
