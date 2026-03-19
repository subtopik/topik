import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { command, positional } from "@drizzle-team/brocli";
import { validateResources } from "@topik/core";
import { parseAllDocuments } from "yaml";
import { CliError } from "../errors";
import { formatValidationFailure } from "../validation-output";

function parseJson(path: string, content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new CliError(`Failed to parse JSON resource file ${path}`, { cause: error });
  }
}

function parseJsonl(path: string, content: string): unknown[] {
  return content
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, index }) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new CliError(`Failed to parse JSONL resource file ${path} at line ${index}`, {
          cause: error,
        });
      }
    });
}

function parseYaml(path: string, content: string): unknown[] {
  try {
    return parseAllDocuments(content)
      .filter((document) => document.contents !== null)
      .map((document) => {
        if (document.errors.length > 0) {
          throw document.errors[0];
        }
        return document.toJS();
      });
  } catch (error) {
    throw new CliError(`Failed to parse YAML resource file ${path}`, { cause: error });
  }
}

async function readResourceFile(path: string): Promise<unknown[]> {
  const content = await readFile(path, "utf-8");
  const extension = extname(path).toLowerCase();

  switch (extension) {
    case ".json":
      return [parseJson(path, content)];
    case ".jsonl":
      return parseJsonl(path, content);
    case ".yaml":
    case ".yml":
      return parseYaml(path, content);
    default:
      throw new CliError(`Unsupported resource file format for ${path}`);
  }
}

export async function loadResources(path: string): Promise<unknown[]> {
  const info = await stat(path).catch((error) => {
    throw new CliError(`Failed to access ${path}`, { cause: error });
  });

  if (info.isFile()) {
    return readResourceFile(path);
  }

  const entries = await readdir(path, { withFileTypes: true, recursive: true });
  const resourceFiles = entries.filter((entry) => {
    if (!entry.isFile()) {
      return false;
    }

    const extension = extname(entry.name).toLowerCase();
    return (
      extension === ".json" ||
      extension === ".jsonl" ||
      extension === ".yaml" ||
      extension === ".yml"
    );
  });

  const resources = await Promise.all(
    resourceFiles.map((entry) => readResourceFile(join(entry.parentPath, entry.name))),
  );

  return resources.flat();
}

export const validate = command({
  name: "validate",
  desc: "Validate wiki resource files in JSON, JSONL, or YAML format against schemas",
  options: {
    path: positional("path").desc("File or directory to validate").required(),
  },
  handler: async (options) => {
    const target = resolve(options.path);
    const resources = await loadResources(target);

    if (resources.length === 0) {
      console.log("No resource files found.");
      return;
    }

    const { valid, errors } = validateResources(resources);

    if (valid) {
      console.log(`Validated ${resources.length} resources`);
    } else {
      throw new CliError(formatValidationFailure(errors, resources.length, "validating resources"));
    }
  },
});
