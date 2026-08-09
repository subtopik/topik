import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { boolean, command, positional, string } from "@drizzle-team/brocli";
import {
  compile as compileContent,
  serializeTopikJson,
  validateResources,
  type LinkValidationPolicy,
} from "@topik/core";
import { printDiagnostics } from "../diagnostics";
import { CliError } from "../errors";
import { formatValidationFailure } from "../validation-output";
import {
  deriveGitSourceNamespace,
  explicitAssetOptions,
  requiresSourceNamespace,
} from "../source-namespace";

export const compile = command({
  name: "compile",
  desc: "Compile wiki content into Topik resource files",
  options: {
    dir: positional("dir").desc("Path to the content directory").default("."),
    outDir: string("out-dir").alias("o").desc("Output directory for compiled resources"),
    format: string("format")
      .alias("f")
      .desc("Output format (canonical JSON only)")
      .enum("json")
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
    sourceNamespace: string("source-namespace").desc(
      "Stable source namespace for implicit local Assets (derived from Git when omitted)",
    ),
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    const links = options.links as LinkValidationPolicy;
    const outDir = options.outDir ? resolve(options.outDir) : join(dir, ".topik", "resources");
    const explicitAssets = explicitAssetOptions(options.sourceNamespace);
    let result: Awaited<ReturnType<typeof compileContent>>;
    try {
      result = await compileContent({ dir, validation: { links }, assets: explicitAssets });
    } catch (error) {
      if (explicitAssets !== undefined || !requiresSourceNamespace(error)) throw error;
      result = await compileContent({
        dir,
        validation: { links },
        assets: { sourceNamespace: await deriveGitSourceNamespace(dir) },
      });
    }
    const { diagnostics, materialization, payloads, resources, semantic } = result;
    printDiagnostics(diagnostics);

    if (options.validate) {
      const { valid, errors } = validateResources(resources);
      if (!valid) {
        throw new CliError(
          formatValidationFailure(errors, resources.length, "validating compiled output"),
        );
      }
    }

    if (options.dryRun) {
      for (const resource of resources) {
        console.log(`${resource.type}/${resource.name}.json`);
      }
      for (const payload of payloads) console.log(payload.path);
      console.log(`\n${resources.length} resources and ${payloads.length} payloads (dry run)`);
      return;
    }

    const materializedResources = new Map(
      materialization.resources.map((resource) => [resource.resource, resource]),
    );
    const files: Array<{ path: string; bytes: string | Uint8Array }> = resources.map((resource) => {
      const materialized = materializedResources.get(`${resource.type}/${resource.name}`);
      if (materialized === undefined) {
        throw new CliError("Compiled materialization omits a resource descriptor");
      }
      return { path: materialized.path, bytes: serializeTopikJson(resource) };
    });
    files.push(
      ...payloads.map((payload) => ({ path: payload.path, bytes: payload.bytes })),
      { path: ".topik/materialization.json", bytes: serializeTopikJson(materialization) },
      { path: ".topik/semantic.json", bytes: serializeTopikJson(semantic) },
    );
    await replaceCompilationTree(outDir, files);

    console.log(
      `Compiled ${resources.length} resources and ${payloads.length} payloads to ${outDir}`,
    );
  },
});

async function replaceCompilationTree(
  absolutePath: string,
  files: readonly { path: string; bytes: string | Uint8Array }[],
): Promise<void> {
  const target = basename(absolutePath);
  if (target.length === 0 || target === "." || target === "..") {
    throw new CliError("Compilation output root is invalid");
  }
  const parent = await openAnchoredOutputDirectory(dirname(absolutePath), true);
  if (parent === undefined) throw new CliError("Compilation output parent could not be created");
  const targetPath = procFdChild(parent.fd, target);
  const existing = await openAnchoredChildDirectory(parent, target, false);
  if (existing !== undefined) {
    await assertSafeOutputTree(existing);
    await existing.close();
  }
  const stageDir = await mkdtemp(procFdChild(parent.fd, ".topik-compilation-stage-"));
  const stageHandle = await open(
    stageDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let backupDir: string | undefined;
  let previousMoved = false;
  try {
    await Promise.all(files.map((file) => writeAnchoredFile(stageHandle, file.path, file.bytes)));
    if (existing !== undefined) {
      backupDir = await mkdtemp(procFdChild(parent.fd, ".topik-compilation-backup-"));
      await rename(targetPath, join(backupDir, "previous"));
      previousMoved = true;
    }
    await rename(stageDir, targetPath);
    if (backupDir !== undefined) await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    const failedTarget = await openAnchoredChildDirectory(parent, target, false);
    const targetMissing = failedTarget === undefined;
    await failedTarget?.close();
    if (previousMoved && targetMissing && backupDir !== undefined) {
      await rename(join(backupDir, "previous"), targetPath).catch(() => undefined);
    }
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    if (backupDir !== undefined) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await stageHandle.close().catch(() => undefined);
    await parent.close().catch(() => undefined);
  }
}

async function openAnchoredOutputDirectory(
  absolutePath: string,
  create: boolean,
): Promise<FileHandle | undefined> {
  if (
    process.platform !== "linux" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw new CliError("This platform cannot prove descriptor-anchored output containment");
  }
  const normalized = resolve(absolutePath);
  if (normalized === "/")
    throw new CliError("Compilation output root cannot be the filesystem root");
  const components = normalized.split("/").filter(Boolean);
  let current = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const child = await openAnchoredChildDirectory(current, component, create);
      if (child === undefined) {
        await current.close();
        return undefined;
      }
      await current.close();
      current = child;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw new CliError("Compilation output has an unsafe or unresolvable ancestor");
  }
}

async function openAnchoredChildDirectory(
  parent: FileHandle,
  component: string,
  create: boolean,
): Promise<FileHandle | undefined> {
  if (
    component.length === 0 ||
    component === "." ||
    component === ".." ||
    component.includes("/")
  ) {
    throw new CliError("Compilation output path is invalid");
  }
  const path = procFdChild(parent.fd, component);
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CliError("Compilation output contains a link or non-directory collision");
    }
    await mkdir(path, { mode: 0o700 }).catch((mkdirError) => {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    });
    try {
      return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      throw new CliError("Compilation output directory identity could not be proven");
    }
  }
}

async function assertSafeOutputTree(directory: FileHandle): Promise<void> {
  for (const entry of await readdir(procFd(directory.fd))) {
    const path = procFdChild(directory.fd, entry);
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
      );
    } catch {
      throw new CliError("Compilation output contains a link or special-node collision");
    }
    try {
      const stat = await handle.stat({ bigint: true });
      if (stat.isDirectory()) {
        await assertSafeOutputTree(handle);
      } else if (!stat.isFile() || stat.nlink !== 1n) {
        throw new CliError("Compilation output contains a hard link or special-node collision");
      }
    } finally {
      await handle.close();
    }
  }
}

async function writeAnchoredFile(
  root: FileHandle,
  relativePath: string,
  bytes: string | Uint8Array,
): Promise<void> {
  const components = safeOutputComponents(relativePath);
  const directories: FileHandle[] = [];
  let parent = root;
  let stagedDirectory: string | undefined;
  let stagedFile: FileHandle | undefined;
  try {
    for (const component of components.slice(0, -1)) {
      const child = await openAnchoredChildDirectory(parent, component, true);
      if (child === undefined) throw new CliError("Compilation output directory is unavailable");
      directories.push(child);
      parent = child;
    }
    const path = procFdChild(parent.fd, components.at(-1) ?? "");
    let existing: FileHandle | undefined;
    try {
      existing = await open(
        path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CliError("Compilation output file is a link or special-node collision");
      }
    }
    if (existing !== undefined) {
      try {
        const stat = await existing.stat({ bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n) {
          throw new CliError("Compilation output file is hard-linked or not regular");
        }
      } finally {
        await existing.close();
      }
    }

    stagedDirectory = await mkdtemp(procFdChild(parent.fd, ".topik-file-stage-"));
    const stagedPath = join(stagedDirectory, "file");
    stagedFile = await open(
      stagedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await stagedFile.writeFile(bytes);
    await stagedFile.chmod(0o644);
    await stagedFile.sync();
    await stagedFile.close();
    stagedFile = undefined;
    await rename(stagedPath, path);
  } finally {
    await stagedFile?.close().catch(() => undefined);
    if (stagedDirectory !== undefined) {
      await rm(stagedDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    await Promise.all(directories.map((handle) => handle.close().catch(() => undefined)));
  }
}

function safeOutputComponents(relativePath: string): string[] {
  const components = relativePath.split("/");
  if (
    relativePath.startsWith("/") ||
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        component.includes("\\"),
    )
  ) {
    throw new CliError("Compilation output path is not safely relative");
  }
  return components;
}

function procFd(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function procFdChild(fd: number, component: string): string {
  return `${procFd(fd)}/${component}`;
}
