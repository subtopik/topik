import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { boolean, command, positional, string } from "@drizzle-team/brocli";
import {
  compile as compileContent,
  parseStrictTopikJson,
  serializeTopikJson,
  validateResources,
  type LinkValidationPolicy,
  type PortableAssetKeyStateV1,
  type Resource,
} from "@topik/core";
import { printDiagnostics } from "../diagnostics";
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
    links: string("links")
      .desc("How unresolved wiki links and local guide fragments are handled")
      .enum("error", "warning", "off")
      .default("error"),
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    const format = options.format as Format;
    const links = options.links as LinkValidationPolicy;
    const outDir = options.outDir ? resolve(options.outDir) : join(dir, ".topik", "resources");
    const keyStatePath = join(outDir, ".topik", "asset-key-state.json");
    await assertSafeOutputTree(outDir);
    const keyState = await readAssetKeyState(keyStatePath);
    const { artifacts, assetKeyState, diagnostics, resources } = await compileContent({
      dir,
      validation: { links },
      assets: { keyState },
    });
    printDiagnostics(diagnostics);

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
      for (const artifact of artifacts) {
        for (const file of artifact.inventory) {
          console.log(`portable/${artifact.resourceRoot}/${file.path}`);
        }
      }
      console.log(
        `\n${resources.length} resources and ${artifacts.length} portable roots (dry run)`,
      );
      return;
    }

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
    await mkdir(dirname(keyStatePath), { recursive: true });
    await writeFile(keyStatePath, serializeTopikJson(assetKeyState));

    await materializePortableRoots(outDir, artifacts);

    console.log(
      `Compiled ${resources.length} resources and ${artifacts.length} portable roots to ${outDir}`,
    );
  },
});

async function readAssetKeyState(path: string): Promise<PortableAssetKeyStateV1 | undefined> {
  try {
    return parseStrictTopikJson(await readFile(path, "utf8")) as PortableAssetKeyStateV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function materializePortableRoots(
  outDir: string,
  artifacts: Awaited<ReturnType<typeof compileContent>>["artifacts"],
): Promise<void> {
  const portableDir = join(outDir, "portable");
  await assertSafeOutputTree(portableDir);
  const stageDir = await mkdtemp(join(outDir, ".topik-portable-stage-"));
  let backupDir: string | undefined;
  let previousMoved = false;
  try {
    await Promise.all(
      artifacts.flatMap((artifact) =>
        artifact.inventory.map(async (file) => {
          const path = join(stageDir, artifact.resourceRoot, file.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.bytes, { flag: "wx" });
        }),
      ),
    );

    await assertSafeOutputTree(portableDir);
    if (await pathExists(portableDir)) {
      backupDir = await mkdtemp(join(outDir, ".topik-portable-backup-"));
      await rename(portableDir, join(backupDir, "portable"));
      previousMoved = true;
    }
    await rename(stageDir, portableDir);
    if (backupDir !== undefined) await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (previousMoved && !(await pathExists(portableDir)) && backupDir !== undefined) {
      await rename(join(backupDir, "portable"), portableDir).catch(() => undefined);
    }
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    if (backupDir !== undefined) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function assertSafeOutputTree(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CliError("Compilation output contains a link or non-directory collision");
  }
  for (const entry of await readdir(path)) {
    const child = join(path, entry);
    const childStat = await lstat(child);
    if (childStat.isSymbolicLink()) {
      throw new CliError("Compilation output contains a link or non-directory collision");
    }
    if (childStat.isDirectory()) await assertSafeOutputTree(child);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
