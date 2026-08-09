import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

const COMPILATION_GENERATION_PREFIX = ".topik-compilation-generation-";
const COMPILATION_PUBLISH_PREFIX = ".topik-compilation-publish-";

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
    await assertCompilationOutputScope(dir, outDir);
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

export interface CompilationReplaceTestHooks {
  beforePublish?: () => void | Promise<void>;
  afterPublish?: () => void | Promise<void>;
}

export async function replaceCompilationTree(
  absolutePath: string,
  files: readonly { path: string; bytes: string | Uint8Array }[],
  hooks: CompilationReplaceTestHooks = {},
): Promise<void> {
  const target = basename(absolutePath);
  if (target.length === 0 || target === "." || target === "..") {
    throw new CliError("Compilation output root is invalid");
  }
  const parent = await openAnchoredOutputDirectory(dirname(absolutePath), true);
  if (parent === undefined) throw new CliError("Compilation output parent could not be created");
  let existing: OwnedCompilationGeneration | undefined;
  let stageHandle: FileHandle | undefined;
  let stageDir: string | undefined;
  let publishDir: string | undefined;
  let published = false;
  try {
    const targetPath = procFdChild(parent.fd, target);
    existing = await openOwnedCompilationGeneration(parent, target);
    stageDir = await mkdtemp(procFdChild(parent.fd, COMPILATION_GENERATION_PREFIX));
    stageHandle = await open(
      stageDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    publishDir = await mkdtemp(procFdChild(parent.fd, COMPILATION_PUBLISH_PREFIX));
    const stagedLink = join(publishDir, "current");
    let operationError: unknown;
    try {
      await Promise.all(
        files.map((file) => writeAnchoredFile(stageHandle as FileHandle, file.path, file.bytes)),
      );
      await stageHandle.sync();
      await hooks.beforePublish?.();
      if (existing !== undefined) {
        await assertCompilationGenerationBinding(parent, target, existing);
        try {
          await symlink(basename(stageDir), stagedLink, "dir");
          await rename(stagedLink, targetPath);
        } catch {
          throw new CliError("Compilation output pointer could not be replaced atomically");
        }
      } else {
        await assertOutputTargetAbsent(targetPath);
        try {
          await symlink(basename(stageDir), targetPath, "dir");
        } catch {
          throw new CliError("Compilation output pointer could not be published atomically");
        }
      }
      published = true;
      await parent.sync();
      await hooks.afterPublish?.();
    } catch (error) {
      operationError = error;
    }
    if (published && existing !== undefined) {
      try {
        await removeOwnedCompilationGeneration(parent, existing);
      } catch (error) {
        operationError ??= error;
      }
    }
    if (operationError !== undefined) throw operationError;
  } finally {
    await stageHandle?.close().catch(() => undefined);
    await existing?.handle.close().catch(() => undefined);
    if (publishDir !== undefined) {
      await rm(publishDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (stageDir !== undefined && !published) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await parent.close().catch(() => undefined);
  }
}

interface OwnedCompilationGeneration {
  target: string;
  handle: FileHandle;
  identity: { dev: bigint; ino: bigint };
  pointerIdentity: { dev: number; ino: number };
}

async function openOwnedCompilationGeneration(
  parent: FileHandle,
  target: string,
): Promise<OwnedCompilationGeneration | undefined> {
  const targetPath = procFdChild(parent.fd, target);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError("Compilation output target could not be inspected safely");
  }

  if (!stat.isSymbolicLink()) {
    if (!stat.isDirectory()) {
      throw new CliError("Compilation output contains a link or non-directory collision");
    }
    const directory = await openAnchoredChildDirectory(parent, target, false);
    if (directory === undefined) {
      throw new CliError("Compilation output directory identity could not be proven");
    }
    try {
      await assertSafeOutputTree(directory);
      await assertOwnedCompilationTree(directory);
    } finally {
      await directory.close().catch(() => undefined);
    }
    throw new CliError(
      "Existing directory output cannot be replaced atomically; choose a new output path",
    );
  }

  let generation: string;
  try {
    generation = await readlink(targetPath, { encoding: "utf8" });
  } catch {
    throw new CliError("Compilation output generation pointer could not be read safely");
  }
  if (!isCompilationGenerationName(generation)) {
    throw new CliError("Existing compilation output is populated but is not recognized as owned");
  }
  const handle = await openAnchoredChildDirectory(parent, generation, false);
  if (handle === undefined) {
    throw new CliError("Existing compilation output generation is missing");
  }
  try {
    await assertSafeOutputTree(handle);
    await assertOwnedCompilationTree(handle);
    const identity = await handle.stat({ bigint: true });
    return {
      target: generation,
      handle,
      identity: { dev: identity.dev, ino: identity.ino },
      pointerIdentity: { dev: stat.dev, ino: stat.ino },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertCompilationGenerationBinding(
  parent: FileHandle,
  target: string,
  existing: OwnedCompilationGeneration,
): Promise<void> {
  let pointerIdentity: Awaited<ReturnType<typeof lstat>>;
  try {
    pointerIdentity = await lstat(procFdChild(parent.fd, target));
  } catch {
    throw new CliError("Compilation output identity changed before atomic publish");
  }
  if (
    !pointerIdentity.isSymbolicLink() ||
    pointerIdentity.dev !== existing.pointerIdentity.dev ||
    pointerIdentity.ino !== existing.pointerIdentity.ino
  ) {
    throw new CliError("Compilation output identity changed before atomic publish");
  }
  let current: string;
  try {
    current = await readlink(procFdChild(parent.fd, target), { encoding: "utf8" });
  } catch {
    throw new CliError("Compilation output identity changed before atomic publish");
  }
  if (current !== existing.target) {
    throw new CliError("Compilation output identity changed before atomic publish");
  }
  await assertDirectoryIdentity(procFdChild(parent.fd, existing.target), existing.identity);
}

async function assertOutputTargetAbsent(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CliError("Compilation output target could not be inspected safely");
  }
  throw new CliError("Compilation output appeared before atomic publish");
}

async function removeOwnedCompilationGeneration(
  parent: FileHandle,
  existing: OwnedCompilationGeneration,
): Promise<void> {
  const path = procFdChild(parent.fd, existing.target);
  await assertDirectoryIdentity(path, existing.identity);
  try {
    await rm(path, { recursive: true, force: false });
  } catch {
    throw new CliError("Superseded compilation generation could not be removed safely");
  }
}

function isCompilationGenerationName(value: string): boolean {
  return (
    value.startsWith(COMPILATION_GENERATION_PREFIX) &&
    value.length > COMPILATION_GENERATION_PREFIX.length &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

async function assertDirectoryIdentity(
  path: string,
  expected: { dev: bigint; ino: bigint },
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const actual = await handle.stat({ bigint: true });
    if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new CliError("Compilation output identity changed during publish");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Compilation output identity changed during publish");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertCompilationOutputScope(sourceDir: string, outDir: string): Promise<void> {
  let canonicalOutput = outDir;
  try {
    canonicalOutput = await realpath(outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CliError("Compilation output scope could not be proven safely");
    }
  }
  let canonicalSource: string;
  try {
    canonicalSource = await realpath(sourceDir);
  } catch {
    throw new CliError("Compilation source scope could not be proven safely");
  }
  const relation = relative(canonicalOutput, canonicalSource);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new CliError("Compilation output cannot equal or contain the source directory");
  }
}

async function assertOwnedCompilationTree(directory: FileHandle): Promise<void> {
  const materialization = await readOwnedDescriptor(directory, ".topik/materialization.json");
  const semantic = await readOwnedDescriptor(directory, ".topik/semantic.json");
  if (
    materialization?.descriptor !== "topik-materialization-v1" ||
    !Array.isArray(materialization.resources) ||
    !Array.isArray(materialization.payloads) ||
    semantic?.descriptor !== "topik-asset-semantic-v1" ||
    !Array.isArray(semantic.assetNames) ||
    !Array.isArray(semantic.references)
  ) {
    throw new CliError("Existing compilation output is populated but is not recognized as owned");
  }
}

async function readOwnedDescriptor(
  root: FileHandle,
  relativePath: string,
): Promise<Record<string, unknown> | undefined> {
  const components = safeOutputComponents(relativePath);
  const directories: FileHandle[] = [];
  let parent = root;
  let handle: FileHandle | undefined;
  try {
    for (const component of components.slice(0, -1)) {
      const child = await openAnchoredChildDirectory(parent, component, false);
      if (child === undefined) return undefined;
      directories.push(child);
      parent = child;
    }
    handle = await open(
      procFdChild(parent.fd, components.at(-1) ?? ""),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) return undefined;
    const value = JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
    await Promise.all(directories.map((entry) => entry.close().catch(() => undefined)));
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
