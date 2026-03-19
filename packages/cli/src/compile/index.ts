import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { boolean, command, positional, string } from "@drizzle-team/brocli";
import { compile as compileContent, validateResources, type Resource } from "@topik/core";
import { CliError } from "../errors";
import { formatValidationFailure } from "../validation-output";

type Format = "json" | "jsonl" | "yaml";

const formatExtensions: Record<Format, string> = {
  json: ".json",
  jsonl: ".jsonl",
  yaml: ".yaml",
};

async function toYaml(value: unknown): Promise<string> {
  if (process.versions.bun) {
    return Bun.YAML.stringify(value);
  }
  const { stringify } = await import("yaml");
  return stringify(value);
}

function serialize(resource: Resource, format: Format): Promise<string> {
  switch (format) {
    case "json":
      return Promise.resolve(JSON.stringify(resource, null, 2) + "\n");
    case "jsonl":
      return Promise.resolve(JSON.stringify(resource) + "\n");
    case "yaml":
      return toYaml(resource);
  }
}

export const compile = command({
  name: "compile",
  desc: "Compile wiki content into Topik resource files",
  options: {
    dir: positional("dir").desc("Path to the content directory").default("."),
    outDir: string("out-dir").alias("o").desc("Output directory for compiled resources"),
    format: string("format")
      .alias("f")
      .desc("Output format")
      .enum("json", "jsonl", "yaml")
      .default("json"),
    dryRun: boolean("dry-run")
      .desc("Show what would be compiled without writing files")
      .default(false),
    clean: boolean("clean").desc("Remove existing output before compiling").default(false),
    validate: boolean("validate")
      .desc("Validate compiled resources against schemas")
      .default(false),
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    const format = options.format as Format;
    const { resources } = await compileContent({ dir });

    if (options.validate) {
      const { valid, errors } = validateResources(resources);
      if (!valid) {
        throw new CliError(
          formatValidationFailure(errors, resources.length, "validating compiled output"),
        );
      }
    }

    const ext = formatExtensions[format];

    if (options.dryRun) {
      for (const resource of resources) {
        console.log(`${resource.type}/${resource.name}${ext}`);
      }
      console.log(`\n${resources.length} resources (dry run)`);
      return;
    }

    const outDir = options.outDir ? resolve(options.outDir) : join(dir, ".topik", "resources");

    if (options.clean) {
      await rm(outDir, { recursive: true, force: true });
    }

    const types = new Set(resources.map((r) => r.type));
    await Promise.all([...types].map((type) => mkdir(join(outDir, type), { recursive: true })));

    await Promise.all(
      resources.map(async (resource) =>
        writeFile(
          join(outDir, resource.type, `${resource.name}${ext}`),
          await serialize(resource, format),
        ),
      ),
    );

    console.log(`Compiled ${resources.length} resources to ${outDir}`);
  },
});
