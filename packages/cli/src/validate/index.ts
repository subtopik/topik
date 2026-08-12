import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { command, positional } from "@drizzle-team/brocli";
import { validateResources } from "@topik/core";
import { parseAllDocuments } from "yaml";
import { PublicCliError } from "../errors";

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new PublicCliError("resource-json-invalid");
  }
}

function parseJsonl(content: string): unknown[] {
  return content
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

export async function loadResources(path: string): Promise<unknown[]> {
  const info = await stat(path).catch(() => {
    throw new PublicCliError("resource-access-failed");
  });

  if (info.isFile()) {
    return readResourceFile(path);
  }

  const entries = await readdir(path, { withFileTypes: true, recursive: true }).catch(() => {
    throw new PublicCliError("resource-read-failed");
  });
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

    const { valid } = validateResources(resources);

    if (valid) {
      console.log(`Validated ${resources.length} resources`);
    } else {
      throw new PublicCliError("resource-validation-failed");
    }
  },
});
