import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { boolean, command, positional, string } from "@drizzle-team/brocli";
import {
  CompileError,
  DEFAULT_FILE_SAFETY,
  OutputPublicationError,
  compile as compileContent,
  isErrorDiagnostic,
  parseStrictTopikJson,
  publishOutputDirectory,
  type OutputPublicationResult,
  serializeTopikJson,
  validateTopikMaterializationRecord,
  validateResources,
  type FileSafety,
  type LinkValidationPolicy,
  type OutputPublicationErrorReason,
  type OwnedOutputEntry,
  type Resource,
  type TopikMaterializationRecordV1,
} from "@topik/core";
import { printDiagnostics } from "../diagnostics";
import { CliError, PublicCliError, withProjectPlatformRequirement } from "../errors";
import { fileSafetyOption, notePortableReads } from "../file-safety";
import { formatValidationFailure } from "../validation-output";

const COMPILATION_GENERATION_PREFIX = ".topik-compilation-generation-";
const COMPILATION_PRIOR_PREFIX = ".topik-compilation-prior-";
const COMPILATION_DIRECTORIES = ["blobs", "resources"] as const;
const PUBLISHED_FILE_MODE = 0o644;
const ownedDescriptorDecoder = new TextDecoder("utf-8", { fatal: true });
const ownedDescriptorEncoder = new TextEncoder();

export const compile = command({
  name: "compile",
  desc: "Compile project content into Topik resource files",
  options: {
    dir: positional("dir").desc("Project directory containing .topik.yaml").default("."),
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
    fileSafety: fileSafetyOption(),
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    const fileSafety = options.fileSafety;
    const links = options.links as LinkValidationPolicy;
    if (options.outDir === "") throw new PublicCliError("compilation-output-empty");
    const outDir = options.outDir !== undefined ? resolve(options.outDir) : join(dir, ".topik");
    await assertCompilationOutputScope(dir, outDir);
    notePortableReads(fileSafety);
    const result = await compileContent({ dir, validation: { links }, fileSafety }).catch(
      (error: unknown) => {
        if (!(error instanceof CompileError)) throw withProjectPlatformRequirement(error);
        // The diagnostics are sanitized by CompileError; print them as lint does.
        printDiagnostics(error.diagnostics);
        console.error(`${error.diagnostics.filter(isErrorDiagnostic).length} compile error(s)`);
        throw new PublicCliError("compilation-failed", { cause: error });
      },
    );
    const { diagnostics, materialization, payloads, resources, semantic } = result;
    printDiagnostics(diagnostics);

    if (options.validate) {
      const { valid, errors } = validateResources(resources);
      if (!valid) {
        console.error(
          formatValidationFailure(errors, resources.length, "validating compiled output"),
        );
        throw new PublicCliError("compilation-validation-failed");
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
    const { priorRetained } = await replaceCompilationTree(outDir, files, fileSafety, dir);

    console.log(
      `Compiled ${resources.length} resources and ${payloads.length} payloads to ${outDir}`,
    );
    const leftovers = await leftoverPublicationDirectories(outDir);
    if (priorRetained || leftovers > 0)
      console.error(
        priorRetained
          ? `Warning: the previous output could not be removed; it remains beside the output in a directory starting with ${COMPILATION_PRIOR_PREFIX}`
          : `Note: ${leftovers} director${leftovers === 1 ? "y" : "ies"} beside the output starting with ${COMPILATION_GENERATION_PREFIX} or ${COMPILATION_PRIOR_PREFIX} remain from an interrupted compile. Remove them once no other compile is running.`,
      );
  },
});

/**
 * Staging and prior directories beside the output, left by a compile that was killed. They are
 * reported rather than removed: another compile may own one, and a prior output is the only
 * copy a failed publication leaves for manual recovery.
 */
async function leftoverPublicationDirectories(outDir: string): Promise<number> {
  try {
    return (await readdir(dirname(outDir))).filter(
      (name) =>
        name.startsWith(COMPILATION_GENERATION_PREFIX) || name.startsWith(COMPILATION_PRIOR_PREFIX),
    ).length;
  } catch {
    return 0;
  }
}

export async function replaceCompilationTree(
  absolutePath: string,
  files: readonly { path: string; bytes: string | Uint8Array }[],
  fileSafety: FileSafety = DEFAULT_FILE_SAFETY,
  projectDirectory?: string,
): Promise<OutputPublicationResult> {
  try {
    return await publishOutputDirectory(absolutePath, files, {
      fileSafety,
      projectDirectory,
      generationPrefix: COMPILATION_GENERATION_PREFIX,
      priorPrefix: COMPILATION_PRIOR_PREFIX,
      directories: COMPILATION_DIRECTORIES,
      fileMode: PUBLISHED_FILE_MODE,
      isOwned: isOwnedCompilationTree,
    });
  } catch (error) {
    throw toCompilationOutputError(error);
  }
}

const COMPILATION_OUTPUT_ERRORS = {
  "target-collision": "compilation-output-collision",
  "ancestor-collision": "compilation-output-collision",
  "not-owned": "compilation-output-not-owned",
  "ancestor-unsafe": "compilation-output-ancestor-unsafe",
  "platform-unsupported": "compilation-output-platform-unsupported",
  "publication-failed": "compilation-publication-failed",
} as const satisfies Record<OutputPublicationErrorReason, string>;

/** Present core's fixed publication failures with the CLI's catalog wording. */
function toCompilationOutputError(error: unknown): unknown {
  if (!(error instanceof OutputPublicationError)) return error;
  if (error.reason === undefined)
    return new PublicCliError("compilation-output-unsafe", { cause: error });
  // A failed publication keeps the original failure as its cause, as before extraction.
  const cause = error.reason === "publication-failed" ? error.cause : undefined;
  return new PublicCliError(COMPILATION_OUTPUT_ERRORS[error.reason], { cause });
}

async function assertCompilationOutputScope(sourceDir: string, outDir: string): Promise<void> {
  let canonicalOutput = outDir;
  try {
    canonicalOutput = await realpath(outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PublicCliError("compilation-output-scope-unproven", { cause: error });
    }
  }
  let canonicalSource: string;
  try {
    canonicalSource = await realpath(sourceDir);
  } catch {
    throw new PublicCliError("compilation-source-access-failed");
  }
  const relation = relative(canonicalOutput, canonicalSource);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new PublicCliError("compilation-output-contains-source");
  }
}

function isOwnedCompilationTree(
  entries: readonly OwnedOutputEntry[],
  readFile: (path: string) => Uint8Array,
): boolean {
  const materialization = parseBoundCanonicalJson(readFile, "materialization.json");
  const semantic = parseBoundCanonicalJson(readFile, "semantic.json");
  if (!isRecord(materialization) || !Array.isArray(materialization.resources)) {
    throw new TypeError("Materialization resource inventory is unavailable");
  }

  const resources: unknown[] = materialization.resources.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      throw new TypeError("Materialization resource inventory is malformed");
    }
    return parseBoundCanonicalJson(readFile, entry.path);
  });
  if (!isValidResourceSet(resources)) {
    throw new TypeError("Compiled resource inventory is invalid");
  }
  const closure = validateTopikMaterializationRecord(materialization, resources, semantic);
  if (!closure.ok) throw new TypeError("Compilation identity records do not close");
  assertBoundTreeMatchesInventory(entries, closure.value);
  return true;
}

function parseBoundCanonicalJson(readFile: (path: string) => Uint8Array, path: string): unknown {
  const bytes = readFile(path);
  const text = ownedDescriptorDecoder.decode(bytes);
  const value = parseStrictTopikJson(text, Number.POSITIVE_INFINITY);
  const canonicalBytes = ownedDescriptorEncoder.encode(serializeTopikJson(value));
  if (!Buffer.from(bytes).equals(canonicalBytes)) {
    throw new TypeError("Compilation descriptor is not canonical");
  }
  return value;
}

function assertBoundTreeMatchesInventory(
  entries: readonly OwnedOutputEntry[],
  materialization: TopikMaterializationRecordV1,
): void {
  const expectedDirectories = new Set<string>(["", ...COMPILATION_DIRECTORIES]);
  const expectedFiles = new Map<string, { sha256?: string; size?: number }>([
    ["materialization.json", {}],
    ["semantic.json", {}],
  ]);
  for (const entry of [...materialization.resources, ...materialization.payloads]) {
    assertSafeInventoryPath(entry.path);
    if (expectedFiles.has(entry.path)) throw new TypeError("Compilation inventory repeats a path");
    expectedFiles.set(entry.path, { sha256: entry.sha256, size: entry.size });
    const components = entry.path.split("/");
    for (let index = 1; index < components.length; index++) {
      expectedDirectories.add(components.slice(0, index).join("/"));
    }
  }

  if (entries.length !== expectedDirectories.size + expectedFiles.size) {
    throw new TypeError("Compilation tree contains an unexpected path");
  }
  for (const entry of entries) {
    if (entry.kind === "directory") {
      if (!expectedDirectories.has(entry.path)) {
        throw new TypeError("Compilation tree contains an unexpected directory");
      }
      continue;
    }
    const expected = expectedFiles.get(entry.path);
    if (
      expected === undefined ||
      (expected.size !== undefined && entry.size !== BigInt(expected.size)) ||
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

/** Inventory paths must be `/`-separated and safely relative, as staged output paths are. */
function assertSafeInventoryPath(relativePath: string): void {
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
    throw new TypeError("Compilation inventory path is not safely relative");
  }
}
