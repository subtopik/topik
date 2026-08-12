import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { boolean, command, positional, string } from "@drizzle-team/brocli";
import {
  compile as compileContent,
  parseStrictTopikJson,
  serializeTopikJson,
  validateTopikMaterializationRecord,
  validateResources,
  type LinkValidationPolicy,
  type Resource,
  type TopikMaterializationRecordV1,
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
const COMPILATION_PRIOR_PREFIX = ".topik-compilation-prior-";
const COMPILATION_DIRECTORIES = ["blobs", "resources"] as const;
const ownedDescriptorDecoder = new TextDecoder("utf-8", { fatal: true });
const ownedDescriptorEncoder = new TextEncoder();

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
    const outDir = options.outDir ? resolve(options.outDir) : join(dir, ".topik");
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
      const paths = [
        ...resources.map((resource) => `resources/${resource.type}/${resource.name}.json`),
        ...payloads.map((payload) => payload.path),
        "materialization.json",
        "semantic.json",
      ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      for (const path of paths) console.log(path);
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
      { path: "materialization.json", bytes: serializeTopikJson(materialization) },
      { path: "semantic.json", bytes: serializeTopikJson(semantic) },
    );
    await replaceCompilationTree(outDir, files);

    console.log(
      `Compiled ${resources.length} resources and ${payloads.length} payloads to ${outDir}`,
    );
  },
});

export async function replaceCompilationTree(
  absolutePath: string,
  files: readonly { path: string; bytes: string | Uint8Array }[],
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
  const parent = anchoredParent.handle;
  let existing: OwnedCompilationOutput | undefined;
  let generation: OwnedTemporaryDirectory | undefined;
  let published = false;
  let existingRemoved = false;
  let operationError: unknown;
  try {
    const targetPath = procFdChild(parent.fd, target);
    existing = await openOwnedCompilationOutput(parent, target);
    generation = await createOwnedTemporaryDirectory(parent, COMPILATION_GENERATION_PREFIX);
    for (const directory of COMPILATION_DIRECTORIES) {
      const handle = await openAnchoredChildDirectory(generation.handle, directory, true);
      if (handle === undefined) {
        throw new CliError("Compilation output directory is unavailable");
      }
      await handle.close();
    }
    for (const file of stagedFiles) {
      await writeAnchoredFile(generation.handle, file.path, file.bytes);
    }
    generation.tree = bindCompleteCompilationTreeSync(generation.handle);
    assertExpectedStagedTree(generation.tree, stagedFiles);

    if (existing !== undefined) {
      const priorName = `${COMPILATION_PRIOR_PREFIX}${randomUUID()}`;
      assertOutputPathAbsent(procFdChild(parent.fd, priorName));
      renameSync(targetPath, procFdChild(parent.fd, priorName));
      existing.name = priorName;
    }

    renameSync(generation.path, targetPath);
    generation.path = targetPath;
    generation.name = target;
    published = true;

    if (existing !== undefined) {
      cleanupCompilationDirectory(parent, existing);
      existingRemoved = true;
    }
  } catch (error) {
    operationError = error;
  }
  if (generation !== undefined && !published) {
    try {
      generation.tree = bindCompleteCompilationTreeSync(generation.handle);
      cleanupCompilationDirectory(parent, generation);
    } catch (error) {
      operationError ??= error;
    }
  }
  if (existing !== undefined && !existingRemoved && existing.name !== target) {
    try {
      cleanupCompilationDirectory(parent, existing);
    } catch (error) {
      operationError ??= error;
    }
  }
  await generation?.handle.close().catch(() => undefined);
  await existing?.handle.close().catch(() => undefined);
  await parent.close().catch(() => undefined);
  if (operationError !== undefined) throw operationError;
}

interface OwnedTemporaryDirectory {
  name: string;
  path: string;
  handle: FileHandle;
  tree: BoundCompilationTree;
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
    return { name: basename(path), path, handle, tree: { entries: [] } };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    try {
      rmdirSync(procFdChild(parent.fd, basename(path)));
    } catch {
      // The staging-open failure remains the actionable error.
    }
    if (error instanceof CliError) throw error;
    throw new CliError("Compilation staging directory could not be opened safely");
  }
}

type OwnedCompilationOutput = OwnedTemporaryDirectory;

async function openOwnedCompilationOutput(
  parent: FileHandle,
  target: string,
): Promise<OwnedCompilationOutput | undefined> {
  const targetPath = procFdChild(parent.fd, target);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError("Compilation output target could not be inspected safely");
  }

  if (!stat.isDirectory()) {
    throw new CliError("Compilation output contains a link or non-directory collision");
  }
  const directory = await openAnchoredChildDirectory(parent, target, false);
  if (directory === undefined) {
    throw new CliError("Compilation output directory could not be opened safely");
  }
  try {
    const tree = bindCompleteCompilationTreeSync(directory);
    assertOwnedCompilationTree(directory, tree);
    return { handle: directory, name: target, path: targetPath, tree };
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
}

function cleanupCompilationDirectory(
  parent: FileHandle,
  directory: Pick<OwnedTemporaryDirectory, "handle" | "name" | "tree">,
): void {
  for (const entry of [...directory.tree.entries].reverse()) {
    if (entry.path.length === 0) continue;
    const path = `${procFd(directory.handle.fd)}/${entry.path}`;
    if (entry.kind === "file") unlinkSync(path);
    else rmdirSync(path);
  }
  rmdirSync(procFdChild(parent.fd, directory.name));
}

function assertOutputPathAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CliError("Compilation replacement storage could not be inspected safely");
  }
  throw new CliError("Compilation replacement storage is already occupied");
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

function assertOwnedCompilationTree(directory: FileHandle, tree: BoundCompilationTree): void {
  try {
    const materialization = parseBoundCanonicalJson(directory, tree, "materialization.json");
    const semantic = parseBoundCanonicalJson(directory, tree, "semantic.json");
    if (!isRecord(materialization) || !Array.isArray(materialization.resources)) {
      throw new TypeError("Materialization resource inventory is unavailable");
    }

    const resources: unknown[] = materialization.resources.map((entry) => {
      if (!isRecord(entry) || typeof entry.path !== "string") {
        throw new TypeError("Materialization resource inventory is malformed");
      }
      return parseBoundCanonicalJson(directory, tree, entry.path);
    });
    if (!isValidResourceSet(resources)) {
      throw new TypeError("Compiled resource inventory is invalid");
    }
    const closure = validateTopikMaterializationRecord(materialization, resources, semantic);
    if (!closure.ok) throw new TypeError("Compilation identity records do not close");
    assertBoundTreeMatchesInventory(tree, closure.value);
  } catch {
    throw new CliError("Existing compilation output is populated but is not recognized as owned");
  }
}

function parseBoundCanonicalJson(
  root: FileHandle,
  tree: BoundCompilationTree,
  path: string,
): unknown {
  const bytes = readBoundCompilationFileSync(root, tree, path);
  const text = ownedDescriptorDecoder.decode(bytes);
  const value = parseStrictTopikJson(text, Number.POSITIVE_INFINITY);
  const canonicalBytes = ownedDescriptorEncoder.encode(serializeTopikJson(value));
  if (!Buffer.from(bytes).equals(canonicalBytes)) {
    throw new TypeError("Compilation descriptor is not canonical");
  }
  return value;
}

function readBoundCompilationFileSync(
  root: FileHandle,
  tree: BoundCompilationTree,
  path: string,
): Uint8Array {
  safeOutputComponents(path);
  const expected = tree.entries.find(
    (entry): entry is Extract<BoundCompilationTreeEntry, { kind: "file" }> =>
      entry.kind === "file" && entry.path === path,
  );
  if (expected === undefined) throw new TypeError("Compilation descriptor is unavailable");

  let fileFd: number | undefined;
  try {
    const anchoredPath = `${procFd(root.fd)}/${path}`;
    fileFd = openSync(
      anchoredPath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
    );
    const before = fstatSync(fileFd, { bigint: true });
    if (
      !before.isFile() ||
      !sameStoredOutputIdentity(toBoundOutputIdentity(before), expected.identity)
    ) {
      throw new TypeError("Compilation descriptor identity changed");
    }
    const bytes = readFileSync(fileFd);
    const after = fstatSync(fileFd, { bigint: true });
    if (!sameBoundOutputIdentity(before, after) || sha256OutputBytes(bytes) !== expected.digest) {
      throw new TypeError("Compilation descriptor bytes changed");
    }
    assertPathStillBindsIdentitySync(anchoredPath, after, "file");
    return Uint8Array.from(bytes);
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
  }
}

function assertBoundTreeMatchesInventory(
  tree: BoundCompilationTree,
  materialization: TopikMaterializationRecordV1,
): void {
  const expectedDirectories = new Set<string>(["", ...COMPILATION_DIRECTORIES]);
  const expectedFiles = new Map<string, { sha256?: string; size?: number }>([
    ["materialization.json", {}],
    ["semantic.json", {}],
  ]);
  for (const entry of [...materialization.resources, ...materialization.payloads]) {
    safeOutputComponents(entry.path);
    if (expectedFiles.has(entry.path)) throw new TypeError("Compilation inventory repeats a path");
    expectedFiles.set(entry.path, { sha256: entry.sha256, size: entry.size });
    const components = entry.path.split("/");
    for (let index = 1; index < components.length; index++) {
      expectedDirectories.add(components.slice(0, index).join("/"));
    }
  }

  if (tree.entries.length !== expectedDirectories.size + expectedFiles.size) {
    throw new TypeError("Compilation tree contains an unexpected path");
  }
  for (const entry of tree.entries) {
    if (entry.kind === "directory") {
      if (!expectedDirectories.has(entry.path)) {
        throw new TypeError("Compilation tree contains an unexpected directory");
      }
      continue;
    }
    const expected = expectedFiles.get(entry.path);
    if (
      expected === undefined ||
      (expected.size !== undefined && entry.identity.size !== BigInt(expected.size)) ||
      (expected.sha256 !== undefined && entry.digest !== expected.sha256)
    ) {
      throw new TypeError("Compilation tree does not match its inventory");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidResourceSet(resources: readonly unknown[]): resources is readonly Resource[] {
  return validateResources(resources).valid;
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
    return { handle: current };
  } catch (error) {
    await current.close().catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw new CliError("Compilation output has an unsafe or unresolvable ancestor");
  }
}

interface AnchoredOutputDirectory {
  handle: FileHandle;
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
    throw new CliError("Compilation generation contents could not be inspected safely");
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
    if (!child.isFile()) {
      throw new CliError("Compilation generation contains a link or special-node entry");
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
        throw new CliError("Compilation generation contains a hard link or unsafe file entry");
      }
      const bytes = readFileSync(fileFd);
      const fileAfter = fstatSync(fileFd, { bigint: true });
      if (!sameBoundOutputIdentity(fileBefore, fileAfter)) {
        throw new CliError("Compilation generation file changed while it was inspected");
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
    throw new CliError("Compilation generation directory changed while it was inspected");
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
    throw new CliError("Compilation generation path binding changed while it was inspected");
  }
}

function assertExpectedStagedTree(
  tree: BoundCompilationTree,
  files: readonly StagedCompilationFile[],
): void {
  const expectedDirectories = new Set<string>([""]);
  for (const directory of COMPILATION_DIRECTORIES) expectedDirectories.add(directory);
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

async function writeAnchoredFile(
  root: FileHandle,
  relativePath: string,
  bytes: string | Uint8Array,
): Promise<void> {
  const components = safeOutputComponents(relativePath);
  const directories: FileHandle[] = [];
  let parent = root;
  let output: FileHandle | undefined;
  try {
    for (const component of components.slice(0, -1)) {
      const child = await openAnchoredChildDirectory(parent, component, true);
      if (child === undefined) throw new CliError("Compilation output directory is unavailable");
      directories.push(child);
      parent = child;
    }
    const path = procFdChild(parent.fd, components.at(-1) ?? "");
    output = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await output.writeFile(bytes);
    await output.chmod(0o644);
  } finally {
    await output?.close().catch(() => undefined);
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
