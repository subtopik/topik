import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  readdir,
  realpath,
  rename,
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
  sourceNamespaceOptions,
  requiresSourceNamespace,
} from "../source-namespace";

const COMPILATION_GENERATION_PREFIX = ".topik-compilation-generation-";
const COMPILATION_PUBLISH_PREFIX = ".topik-compilation-publish-";
const COMPILATION_FILE_STAGE_PREFIX = ".topik-compilation-file-stage-";

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
      "Stable source namespace for automatically discovered local Assets (derived from Git when omitted)",
    ),
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    const links = options.links as LinkValidationPolicy;
    const outDir = options.outDir ? resolve(options.outDir) : join(dir, ".topik", "resources");
    await assertCompilationOutputScope(dir, outDir);
    const assetOptions = sourceNamespaceOptions(options.sourceNamespace);
    let result: Awaited<ReturnType<typeof compileContent>>;
    try {
      result = await compileContent({ dir, validation: { links }, assets: assetOptions });
    } catch (error) {
      if (assetOptions !== undefined || !requiresSourceNamespace(error)) throw error;
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
  afterSupersededGenerationProof?: () => void | Promise<void>;
  afterPublishStagingProof?: (path: string) => void | Promise<void>;
  afterFileStagingProof?: (path: string) => void | Promise<void>;
  afterFailedGenerationProof?: (path: string) => void | Promise<void>;
  afterStagedGenerationProof?: (path: string) => void | Promise<void>;
  afterPriorGenerationProof?: (path: string) => void | Promise<void>;
  afterOutputTargetProof?: (path: string) => void | Promise<void>;
  afterPublishPointerProof?: (path: string) => void | Promise<void>;
}

export async function replaceCompilationTree(
  absolutePath: string,
  files: readonly { path: string; bytes: string | Uint8Array }[],
  hooks: CompilationReplaceTestHooks = {},
): Promise<void> {
  const stagedFiles = snapshotCompilationFiles(files);
  const target = basename(absolutePath);
  if (target.length === 0 || target === "." || target === "..") {
    throw new CliError("Compilation output root is invalid");
  }
  const anchoredParent = await openAnchoredOutputDirectory(dirname(absolutePath), true);
  if (anchoredParent === undefined) {
    throw new CliError("Compilation output parent could not be created");
  }
  const { bindings: parentBindings, handle: parent } = anchoredParent;
  let existing: OwnedCompilationGeneration | undefined;
  let generation: OwnedTemporaryDirectory | undefined;
  let publishStaging: OwnedTemporaryDirectory | undefined;
  let fileStaging: OwnedTemporaryDirectory | undefined;
  let published = false;
  try {
    const targetPath = procFdChild(parent.fd, target);
    existing = await openOwnedCompilationGeneration(parent, target);
    generation = await createOwnedTemporaryDirectory(parent, COMPILATION_GENERATION_PREFIX);
    fileStaging = await createOwnedTemporaryDirectory(parent, COMPILATION_FILE_STAGE_PREFIX);
    await proveRetainedTemporaryDirectory(fileStaging, hooks.afterFileStagingProof);
    publishStaging = await createOwnedTemporaryDirectory(parent, COMPILATION_PUBLISH_PREFIX);
    await proveRetainedTemporaryDirectory(publishStaging, hooks.afterPublishStagingProof);
    const stagedLink = procFdChild(publishStaging.handle.fd, "current");
    let operationError: unknown;
    try {
      await Promise.all(
        stagedFiles.map((file) =>
          writeAnchoredFile(generation!.handle, fileStaging!.handle, file.path, file.bytes),
        ),
      );
      await generation.handle.sync();
      await hooks.beforePublish?.();
      await assertDirectoryIdentity(generation.path, generation.identity);
      const stagedTree = bindCompleteCompilationTreeSync(generation.handle);
      assertExpectedStagedTree(stagedTree, stagedFiles);
      await hooks.afterStagedGenerationProof?.(generation.path);
      if (existing !== undefined) {
        let stagedPointer: OwnedStagedPointer;
        try {
          await symlink(basename(generation.path), stagedLink, "dir");
          stagedPointer = await proveStagedPointer(stagedLink, basename(generation.path));
        } catch {
          throw new CliError("Compilation output pointer could not be staged safely");
        }
        await hooks.afterPublishPointerProof?.(stagedLink);
        await assertCompilationGenerationBinding(parent, target, existing);
        assertBoundCompilationTreeSync(existing.handle, existing.tree);
        await hooks.afterPriorGenerationProof?.(procFdChild(parent.fd, existing.target));
        await hooks.afterOutputTargetProof?.(targetPath);
        try {
          publishReplacementPointerSync(
            parent,
            target,
            existing,
            generation,
            stagedTree,
            stagedPointer,
            parentBindings,
          );
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError("Compilation output pointer could not be replaced atomically");
        }
      } else {
        await assertOutputTargetAbsent(targetPath);
        await hooks.afterOutputTargetProof?.(targetPath);
        try {
          publishInitialPointerSync(targetPath, generation, stagedTree, parentBindings);
        } catch (error) {
          if (error instanceof CliError) throw error;
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
        await proveSupersededCompilationGeneration(
          parent,
          existing,
          hooks.afterSupersededGenerationProof,
        );
      } catch (error) {
        operationError ??= error;
      }
    }
    if (operationError !== undefined) throw operationError;
  } finally {
    if (generation !== undefined && !published) {
      await proveRetainedTemporaryDirectory(generation, hooks.afterFailedGenerationProof).catch(
        () => undefined,
      );
    }
    await generation?.handle.close().catch(() => undefined);
    await publishStaging?.handle.close().catch(() => undefined);
    await fileStaging?.handle.close().catch(() => undefined);
    await existing?.handle.close().catch(() => undefined);
    await parent.close().catch(() => undefined);
  }
}

function publishInitialPointerSync(
  targetPath: string,
  generation: OwnedTemporaryDirectory,
  stagedTree: BoundCompilationTree,
  parentBindings: readonly CallerVisibleDirectoryBinding[],
): void {
  assertCallerVisibleDirectoryBindingsSync(parentBindings);
  assertDirectoryIdentitySync(generation.path, generation.identity);
  assertBoundCompilationTreeSync(generation.handle, stagedTree);
  assertCallerVisibleDirectoryBindingsSync(parentBindings);
  assertDirectoryIdentitySync(generation.path, generation.identity);
  assertBoundCompilationTreeSync(generation.handle, stagedTree);
  assertCallerVisibleDirectoryBindingsSync(parentBindings);
  assertDirectoryIdentitySync(generation.path, generation.identity);
  try {
    // symlink(2) is the conditional transition: an intervening target produces EEXIST and survives.
    symlinkSync(basename(generation.path), targetPath, "dir");
  } catch {
    throw new CliError("Compilation output changed before conditional publish");
  }
}

function publishReplacementPointerSync(
  parent: FileHandle,
  target: string,
  existing: OwnedCompilationGeneration,
  generation: OwnedTemporaryDirectory,
  stagedTree: BoundCompilationTree,
  stagedPointer: OwnedStagedPointer,
  parentBindings: readonly CallerVisibleDirectoryBinding[],
): void {
  // Node does not expose an inode-conditional rename. Recheck both descriptor-backed bindings and
  // perform the single atomic rename synchronously, with no promise, callback, or event-loop yield
  // in between. The deterministic seam is before these final checks.
  assertCallerVisibleDirectoryBindingsSync(parentBindings);
  assertDirectoryIdentitySync(generation.path, generation.identity);
  assertBoundCompilationTreeSync(generation.handle, stagedTree);
  assertStagedPointerBindingSync(stagedPointer);
  assertCompilationGenerationBindingSync(parent, target, existing);
  assertBoundCompilationTreeSync(existing.handle, existing.tree);
  assertCallerVisibleDirectoryBindingsSync(parentBindings);
  assertDirectoryIdentitySync(generation.path, generation.identity);
  assertBoundCompilationTreeSync(generation.handle, stagedTree);
  assertStagedPointerBindingSync(stagedPointer);
  assertCompilationGenerationBindingSync(parent, target, existing);
  assertBoundCompilationTreeSync(existing.handle, existing.tree);
  assertCallerVisibleDirectoryBindingsSync(parentBindings);
  assertDirectoryIdentitySync(generation.path, generation.identity);
  assertStagedPointerBindingSync(stagedPointer);
  assertCompilationGenerationBindingSync(parent, target, existing);
  renameSync(stagedPointer.path, procFdChild(parent.fd, target));
}

interface OwnedStagedPointer {
  path: string;
  target: string;
  identity: { dev: number; ino: number };
}

async function proveStagedPointer(path: string, target: string): Promise<OwnedStagedPointer> {
  const stat = await lstat(path);
  const actualTarget = await readlink(path, { encoding: "utf8" });
  if (!stat.isSymbolicLink() || actualTarget !== target) {
    throw new CliError("Compilation output pointer staging identity changed");
  }
  return { path, target, identity: { dev: stat.dev, ino: stat.ino } };
}

function assertStagedPointerBindingSync(staged: OwnedStagedPointer): void {
  try {
    const stat = lstatSync(staged.path);
    const target = readlinkSync(staged.path, { encoding: "utf8" });
    if (
      !stat.isSymbolicLink() ||
      stat.dev !== staged.identity.dev ||
      stat.ino !== staged.identity.ino ||
      target !== staged.target
    ) {
      throw new CliError("Compilation output pointer staging identity changed");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Compilation output pointer staging identity changed");
  }
}

interface OwnedTemporaryDirectory {
  path: string;
  handle: FileHandle;
  identity: DirectoryIdentity;
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

async function createOwnedTemporaryDirectory(
  parent: FileHandle,
  prefix: string,
): Promise<OwnedTemporaryDirectory> {
  const path = await mkdtemp(procFdChild(parent.fd, prefix));
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw new CliError("Compilation staging identity is invalid");
    return { path, handle, identity: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw new CliError("Compilation staging identity could not be proven");
  }
}

async function proveRetainedTemporaryDirectory(
  temporary: OwnedTemporaryDirectory,
  afterProof?: (path: string) => void | Promise<void>,
): Promise<void> {
  await assertDirectoryIdentity(temporary.path, temporary.identity);
  await afterProof?.(temporary.path);
}

interface OwnedCompilationGeneration {
  target: string;
  handle: FileHandle;
  identity: { dev: bigint; ino: bigint };
  pointerIdentity: { dev: number; ino: number };
  tree: BoundCompilationTree;
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
    const tree = bindCompleteCompilationTreeSync(handle);
    return {
      target: generation,
      handle,
      identity: { dev: identity.dev, ino: identity.ino },
      pointerIdentity: { dev: stat.dev, ino: stat.ino },
      tree,
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

function assertCompilationGenerationBindingSync(
  parent: FileHandle,
  target: string,
  existing: OwnedCompilationGeneration,
): void {
  let pointerIdentity: ReturnType<typeof lstatSync>;
  try {
    pointerIdentity = lstatSync(procFdChild(parent.fd, target));
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
    current = readlinkSync(procFdChild(parent.fd, target), { encoding: "utf8" });
  } catch {
    throw new CliError("Compilation output identity changed before atomic publish");
  }
  if (current !== existing.target) {
    throw new CliError("Compilation output identity changed before atomic publish");
  }
  assertDirectoryIdentitySync(procFdChild(parent.fd, existing.target), existing.identity);
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

async function proveSupersededCompilationGeneration(
  parent: FileHandle,
  existing: OwnedCompilationGeneration,
  afterProof?: () => void | Promise<void>,
): Promise<void> {
  const path = procFdChild(parent.fd, existing.target);
  await assertDirectoryIdentity(path, existing.identity);
  await afterProof?.();
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

function assertDirectoryIdentitySync(path: string, expected: { dev: bigint; ino: bigint }): void {
  try {
    const actual = lstatSync(path, { bigint: true });
    if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new CliError("Compilation output identity changed during publish");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Compilation output identity changed during publish");
  }
}

function assertCallerVisibleDirectoryBindingsSync(
  bindings: readonly CallerVisibleDirectoryBinding[],
): void {
  for (const binding of bindings) {
    try {
      const actual = lstatSync(binding.path, { bigint: true });
      if (
        !actual.isDirectory() ||
        actual.dev !== binding.identity.dev ||
        actual.ino !== binding.identity.ino
      ) {
        throw new CliError("Compilation output parent or ancestor changed during publish");
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("Compilation output parent or ancestor changed during publish");
    }
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
): Promise<AnchoredOutputDirectory | undefined> {
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
  const bindings: CallerVisibleDirectoryBinding[] = [];
  try {
    for (let index = 0; index < components.length; index++) {
      const component = components[index];
      const child = await openAnchoredChildDirectory(current, component, create);
      if (child === undefined) {
        await current.close();
        return undefined;
      }
      const stat = await child.stat({ bigint: true });
      bindings.push({
        path: `/${components.slice(0, index + 1).join("/")}`,
        identity: { dev: stat.dev, ino: stat.ino },
      });
      await current.close();
      current = child;
    }
    return { bindings, handle: current };
  } catch (error) {
    await current.close().catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw new CliError("Compilation output has an unsafe or unresolvable ancestor");
  }
}

interface AnchoredOutputDirectory {
  bindings: CallerVisibleDirectoryBinding[];
  handle: FileHandle;
}

interface CallerVisibleDirectoryBinding {
  path: string;
  identity: DirectoryIdentity;
}

interface StagedCompilationFile {
  path: string;
  bytes: Uint8Array;
  digest: string;
}

interface BoundOutputIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
}

type BoundCompilationTreeEntry =
  | { path: string; kind: "directory"; identity: BoundOutputIdentity }
  | { path: string; kind: "file"; identity: BoundOutputIdentity; digest: string };

interface BoundCompilationTree {
  entries: readonly BoundCompilationTreeEntry[];
}

function snapshotCompilationFiles(
  files: readonly { path: string; bytes: string | Uint8Array }[],
): readonly StagedCompilationFile[] {
  const paths = new Set<string>();
  const snapshots = files.map((file) => {
    safeOutputComponents(file.path);
    if (paths.has(file.path)) {
      throw new CliError("Compilation output repeats a staged file path");
    }
    paths.add(file.path);
    const bytes =
      typeof file.bytes === "string"
        ? Uint8Array.from(Buffer.from(file.bytes, "utf8"))
        : Uint8Array.from(file.bytes);
    return { path: file.path, bytes, digest: sha256OutputBytes(bytes) };
  });
  for (const path of paths) {
    const components = safeOutputComponents(path);
    for (let index = 1; index < components.length; index++) {
      if (paths.has(components.slice(0, index).join("/"))) {
        throw new CliError("Compilation output has a parent/file collision");
      }
    }
  }
  return snapshots;
}

function bindCompleteCompilationTreeSync(root: FileHandle): BoundCompilationTree {
  const entries: BoundCompilationTreeEntry[] = [];
  try {
    inspectBoundDirectorySync(root.fd, "", entries);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Compilation generation contents could not be proven safely");
  }
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  return { entries };
}

function inspectBoundDirectorySync(
  directoryFd: number,
  prefix: string,
  entries: BoundCompilationTreeEntry[],
): void {
  const before = fstatSync(directoryFd, { bigint: true });
  if (!before.isDirectory()) {
    throw new CliError("Compilation generation contains an unsafe directory entry");
  }
  const children = readdirSync(procFd(directoryFd), { withFileTypes: true }).sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
  );
  for (const child of children) {
    const path = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
    const anchoredPath = procFdChild(directoryFd, child.name);
    if (child.isDirectory()) {
      let childFd: number | undefined;
      try {
        childFd = openSync(
          anchoredPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        inspectBoundDirectorySync(childFd, path, entries);
        const actual = fstatSync(childFd, { bigint: true });
        assertPathStillBindsIdentitySync(anchoredPath, actual, "directory");
      } finally {
        if (childFd !== undefined) closeSync(childFd);
      }
      continue;
    }

    let fileFd: number | undefined;
    try {
      fileFd = openSync(
        anchoredPath,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
      );
      const fileBefore = fstatSync(fileFd, { bigint: true });
      if (!fileBefore.isFile() || fileBefore.nlink !== 1n) {
        throw new CliError("Compilation generation contains an unsafe file entry");
      }
      const bytes = readFileSync(fileFd);
      const fileAfter = fstatSync(fileFd, { bigint: true });
      if (!sameBoundOutputIdentity(fileBefore, fileAfter)) {
        throw new CliError("Compilation generation file changed while it was proven");
      }
      assertPathStillBindsIdentitySync(anchoredPath, fileAfter, "file");
      entries.push({
        path,
        kind: "file",
        identity: toBoundOutputIdentity(fileAfter),
        digest: sha256OutputBytes(bytes),
      });
    } finally {
      if (fileFd !== undefined) closeSync(fileFd);
    }
  }
  const after = fstatSync(directoryFd, { bigint: true });
  if (!sameBoundOutputIdentity(before, after)) {
    throw new CliError("Compilation generation directory changed while it was proven");
  }
  entries.push({ path: prefix, kind: "directory", identity: toBoundOutputIdentity(after) });
}

function assertPathStillBindsIdentitySync(
  path: string,
  expected: BigIntStats,
  kind: "directory" | "file",
): void {
  const actual = lstatSync(path, { bigint: true });
  if (
    (kind === "directory" ? !actual.isDirectory() : !actual.isFile()) ||
    !sameBoundOutputIdentity(actual, expected)
  ) {
    throw new CliError("Compilation generation path binding changed while it was proven");
  }
}

function assertExpectedStagedTree(
  tree: BoundCompilationTree,
  files: readonly StagedCompilationFile[],
): void {
  const expectedDirectories = new Set<string>([""]);
  const expectedFiles = new Map(files.map((file) => [file.path, file] as const));
  for (const file of files) {
    const components = safeOutputComponents(file.path);
    for (let index = 1; index < components.length; index++) {
      expectedDirectories.add(components.slice(0, index).join("/"));
    }
  }
  if (tree.entries.length !== expectedDirectories.size + expectedFiles.size) {
    throw new CliError("Compilation staged generation contains an unexpected path");
  }
  for (const entry of tree.entries) {
    if (entry.kind === "directory") {
      if (!expectedDirectories.has(entry.path)) {
        throw new CliError("Compilation staged generation contains an unexpected directory");
      }
      continue;
    }
    const expected = expectedFiles.get(entry.path);
    if (
      expected === undefined ||
      entry.identity.size !== BigInt(expected.bytes.byteLength) ||
      entry.digest !== expected.digest
    ) {
      throw new CliError("Compilation staged generation bytes do not match expected output");
    }
  }
}

function assertBoundCompilationTreeSync(root: FileHandle, expected: BoundCompilationTree): void {
  const actual = bindCompleteCompilationTreeSync(root);
  if (actual.entries.length !== expected.entries.length) {
    throw new CliError("Compilation generation contents changed before atomic publish");
  }
  for (let index = 0; index < expected.entries.length; index++) {
    const expectedEntry = expected.entries[index];
    const actualEntry = actual.entries[index];
    if (
      expectedEntry.path !== actualEntry.path ||
      expectedEntry.kind !== actualEntry.kind ||
      !sameStoredOutputIdentity(expectedEntry.identity, actualEntry.identity) ||
      (expectedEntry.kind === "file" &&
        (actualEntry.kind !== "file" || expectedEntry.digest !== actualEntry.digest))
    ) {
      throw new CliError("Compilation generation contents changed before atomic publish");
    }
  }
}

function sameBoundOutputIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameStoredOutputIdentity(toBoundOutputIdentity(left), toBoundOutputIdentity(right));
}

function sameStoredOutputIdentity(left: BoundOutputIdentity, right: BoundOutputIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function toBoundOutputIdentity(stat: BigIntStats): BoundOutputIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
  };
}

function sha256OutputBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  staging: FileHandle,
  relativePath: string,
  bytes: string | Uint8Array,
): Promise<void> {
  const components = safeOutputComponents(relativePath);
  const directories: FileHandle[] = [];
  let parent = root;
  let stagedFile: FileHandle | undefined;
  const stagedPath = procFdChild(staging.fd, randomUUID());
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
