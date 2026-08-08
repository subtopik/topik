import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
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
    const existingOutputRoot = await openAnchoredOutputDirectory(outDir, false);
    let keyState: PortableAssetKeyStateV1 | undefined;
    try {
      if (existingOutputRoot !== undefined) await assertSafeOutputTree(existingOutputRoot);
      keyState = await readAssetKeyState(existingOutputRoot);
    } finally {
      await existingOutputRoot?.close();
    }
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

    const outputRoot = await openAnchoredOutputDirectory(outDir, true);
    if (outputRoot === undefined)
      throw new CliError("Compilation output root could not be created");
    try {
      await assertSafeOutputTree(outputRoot);
      if (options.clean) await cleanAnchoredOutputRoot(outputRoot);
      await Promise.all(
        resources.map(async (resource) =>
          writeAnchoredFile(
            outputRoot,
            `${resource.type}/${resource.name}${ext}`,
            await serialize(resource, format),
          ),
        ),
      );
      await writeAnchoredFile(
        outputRoot,
        ".topik/asset-key-state.json",
        serializeTopikJson(assetKeyState),
      );
      await materializePortableRoots(outputRoot, artifacts);
      await assertSafeOutputTree(outputRoot);
      await assertOutputRootIdentity(outDir, outputRoot);
    } finally {
      await outputRoot.close();
    }

    console.log(
      `Compiled ${resources.length} resources and ${artifacts.length} portable roots to ${outDir}`,
    );
  },
});

async function assertOutputRootIdentity(absolutePath: string, expected: FileHandle): Promise<void> {
  const reopened = await openAnchoredOutputDirectory(absolutePath, false);
  if (reopened === undefined) throw new CliError("Compilation output root disappeared");
  try {
    const [before, after] = await Promise.all([
      expected.stat({ bigint: true }),
      reopened.stat({ bigint: true }),
    ]);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new CliError("Compilation output root identity changed during materialization");
    }
  } finally {
    await reopened.close();
  }
}

async function readAssetKeyState(
  outputRoot: FileHandle | undefined,
): Promise<PortableAssetKeyStateV1 | undefined> {
  if (outputRoot === undefined) return undefined;
  try {
    const bytes = await readAnchoredFile(outputRoot, ".topik/asset-key-state.json");
    return bytes === undefined
      ? undefined
      : (parseStrictTopikJson(new TextDecoder().decode(bytes)) as PortableAssetKeyStateV1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function materializePortableRoots(
  outputRoot: FileHandle,
  artifacts: Awaited<ReturnType<typeof compileContent>>["artifacts"],
): Promise<void> {
  const portableDir = procFdChild(outputRoot.fd, "portable");
  const portableHandle = await openAnchoredChildDirectory(outputRoot, "portable", false);
  if (portableHandle !== undefined) {
    await assertSafeOutputTree(portableHandle);
    await portableHandle.close();
  }
  const stageDir = await mkdtemp(procFdChild(outputRoot.fd, ".topik-portable-stage-"));
  const stageHandle = await open(
    stageDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let backupDir: string | undefined;
  let previousMoved = false;
  try {
    await Promise.all(
      artifacts.flatMap((artifact) =>
        artifact.inventory.map((file) =>
          writeAnchoredFile(stageHandle, `${artifact.resourceRoot}/${file.path}`, file.bytes),
        ),
      ),
    );

    const currentPortable = await openAnchoredChildDirectory(outputRoot, "portable", false);
    if (currentPortable !== undefined) {
      await assertSafeOutputTree(currentPortable);
      await currentPortable.close();
      backupDir = await mkdtemp(procFdChild(outputRoot.fd, ".topik-portable-backup-"));
      await rename(portableDir, join(backupDir, "portable"));
      previousMoved = true;
    }
    await rename(stageDir, portableDir);
    if (backupDir !== undefined) await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    const failedPortable = await openAnchoredChildDirectory(outputRoot, "portable", false);
    const portableMissing = failedPortable === undefined;
    await failedPortable?.close();
    if (previousMoved && portableMissing && backupDir !== undefined) {
      await rename(join(backupDir, "portable"), portableDir).catch(() => undefined);
    }
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    if (backupDir !== undefined) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await stageHandle.close().catch(() => undefined);
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

async function readAnchoredFile(
  root: FileHandle,
  relativePath: string,
): Promise<Uint8Array | undefined> {
  const components = safeOutputComponents(relativePath);
  const directories: FileHandle[] = [];
  let parent = root;
  let file: FileHandle | undefined;
  try {
    for (const component of components.slice(0, -1)) {
      const child = await openAnchoredChildDirectory(parent, component, false);
      if (child === undefined) return undefined;
      directories.push(child);
      parent = child;
    }
    try {
      file = await open(
        procFdChild(parent.fd, components.at(-1) ?? ""),
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CliError("Compilation output state is not a safe regular file");
    }
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new CliError("Compilation output state is not a safe regular file");
    }
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new CliError("Compilation output state changed while it was read");
    }
    return bytes;
  } finally {
    await file?.close().catch(() => undefined);
    await Promise.all(directories.map((handle) => handle.close().catch(() => undefined)));
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

async function cleanAnchoredOutputRoot(root: FileHandle): Promise<void> {
  await assertSafeOutputTree(root);
  await Promise.all(
    (await readdir(procFd(root.fd))).map((entry) =>
      rm(procFdChild(root.fd, entry), { recursive: true, force: true }),
    ),
  );
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
