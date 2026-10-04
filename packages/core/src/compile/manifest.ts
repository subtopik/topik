import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { DEFAULT_ASSET_DIRECTORY } from "../config/assets";
import { validateStableSourceNamespace } from "../assets/asset";
import {
  createTopikAssetSemanticRecord,
  createTopikMaterializationRecord,
  validateTopikMaterializationRecord,
} from "../assets/identity";
import { serializeTopikJson } from "../assets/json";
import { validateTopikPath } from "../assets/path";
import {
  TOPIK_MANIFEST_FILENAME,
  topikManifestSchema,
  type TopikManifest,
  type TopikManifestSource,
} from "../config/manifest";
import {
  compileAssetResources,
  AssetCompilationError,
  type AssetCompilationResult,
  type AssetPayload,
  type CompiledResource,
} from "./assets";
import { readConfigurationText, parseSafeConfigurationYaml, readExactConfigFile } from "./config";
import { discoverGuides, type CompileResourceDiscovery } from "./guide";
import { discoverWiki } from "./wiki";
import { PublicCompileError, type PublicCompileErrorId } from "./public-errors";
import { CompileError, throwOnCompileErrors, type CompileResult } from "./shared";
import type { CompileOptions } from "./index";

export interface ManifestSourceDescriptor extends TopikManifestSource {
  /** Zero-based declaration index, used only for provenance and diagnostics. */
  sourceIndex: number;
  /** Canonical root-relative directory; empty for the project root. */
  directory: string;
  /** Effective directory namespace, when a repository namespace was supplied. */
  sourceNamespace?: string;
}

export interface ManifestSourceProvenance extends ManifestSourceDescriptor {
  /** Root-relative destination for new synced media. Compilation does not write here. */
  assetDirectory: string;
  /** Authored resource keys mapped to root-relative content/config paths. */
  sourcePathsByResource: Readonly<Record<string, string>>;
}

export interface ManifestCompileResult extends CompileResult {
  provenance: ManifestSourceProvenance[];
}

export class ManifestSourceError extends PublicCompileError {
  public readonly sourceIndex: number;
  public readonly kind?: TopikManifestSource["kind"];

  constructor(
    id: PublicCompileErrorId,
    sourceIndex: number,
    kind?: TopikManifestSource["kind"],
    config?: string,
  ) {
    super(id, config);
    this.name = "ManifestSourceError";
    this.sourceIndex = sourceIndex;
    this.kind = kind;
  }
}

/** Presence includes invalid files and dangling links: those must fail, never fall back. */
export async function hasRootManifest(dir: string): Promise<boolean> {
  try {
    await lstat(join(dir, TOPIK_MANIFEST_FILENAME));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new PublicCompileError("config-access-failed", TOPIK_MANIFEST_FILENAME);
  }
}

/** Explicit loading requires the canonical file in exactly the supplied root. */
export async function loadTopikManifest(dir: string): Promise<TopikManifest> {
  const raw = await readConfigurationText(dir, TOPIK_MANIFEST_FILENAME);
  let value: unknown;
  try {
    value = parseSafeConfigurationYaml(raw);
  } catch {
    throw new PublicCompileError("manifest-invalid", TOPIK_MANIFEST_FILENAME);
  }
  const parsed = topikManifestSchema.safeParse(value);
  if (!parsed.success) {
    const index = parsed.error.issues.find((issue) => typeof issue.path[1] === "number")?.path[1];
    if (typeof index === "number") {
      const source = (value as { sources?: unknown[] })?.sources?.[index];
      const entry =
        source !== null && typeof source === "object" ? (source as Record<string, unknown>) : {};
      const kind = entry.kind === "wiki" || entry.kind === "collection" ? entry.kind : undefined;
      throw new ManifestSourceError(
        "manifest-invalid",
        index,
        kind,
        typeof entry.config === "string" ? entry.config : undefined,
      );
    }
    throw new PublicCompileError("manifest-invalid", TOPIK_MANIFEST_FILENAME);
  }
  return parsed.data;
}

/** Versioned hash of the compact canonical JSON string tuple (UTF-8, no trailing LF). */
export function deriveManifestSourceNamespace(
  repositoryNamespace: string,
  directory: string,
): string {
  const namespace = validateStableSourceNamespace(repositoryNamespace);
  if (!namespace.ok)
    throw new AssetCompilationError("Invalid repository namespace", namespace.diagnostics);
  if (directory !== "") {
    const path = validateTopikPath(directory);
    if (!path.ok) throw new AssetCompilationError("Invalid source directory", path.diagnostics);
  }
  return `topik-manifest-source-v1:${createHash("sha256")
    .update(JSON.stringify([namespace.value, directory]), "utf8")
    .digest("hex")}`;
}

export async function discoverManifestSources(
  options: CompileOptions,
): Promise<ManifestSourceDescriptor[]> {
  const manifest = await loadTopikManifest(options.dir);
  return manifest.sources.map((source, sourceIndex) => {
    const parent = posix.dirname(source.config);
    const directory = parent === "." ? "" : parent;
    const repositoryNamespace = options.assets?.sourceNamespace;
    return {
      ...source,
      sourceIndex,
      directory,
      ...(repositoryNamespace === undefined
        ? {}
        : { sourceNamespace: deriveManifestSourceNamespace(repositoryNamespace, directory) }),
    };
  });
}

/** Compile only declared sources, sharing the existing local compiler and Asset pipeline. */
export async function compileManifest(options: CompileOptions): Promise<ManifestCompileResult> {
  const root = resolve(options.dir);
  const sources = await discoverManifestSources(options);
  const provenance: ManifestSourceProvenance[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const groups = new Map<
    string,
    { source: ManifestSourceDescriptor; discovered: CompileResourceDiscovery }
  >();
  const authoredKeys = new Set<string>();

  for (const source of sources) {
    let discovered: CompileResourceDiscovery;
    try {
      // Read against the project root so every config path component is checked.
      const selected = await readExactConfigFile(root, source.config);
      const localOptions = { dir: join(root, source.directory), validation: options.validation };
      discovered = await (source.kind === "wiki"
        ? discoverWiki(localOptions, selected)
        : discoverGuides(localOptions, selected));
    } catch (error) {
      throw new ManifestSourceError(
        error instanceof PublicCompileError ? error.id : "manifest-source-failed",
        source.sourceIndex,
        source.kind,
        source.config,
      );
    }
    const paths: Record<string, string> = {};
    for (const resource of discovered.resources) {
      const key = `${resource.type}/${resource.name}`;
      if (authoredKeys.has(key))
        throw new ManifestSourceError(
          "manifest-resource-conflict",
          source.sourceIndex,
          source.kind,
          source.config,
        );
      authoredKeys.add(key);
      paths[key] =
        discovered.sourcePathsByResource[key] === undefined
          ? source.config
          : posix.join(source.directory, discovered.sourcePathsByResource[key]);
    }
    provenance.push({
      ...source,
      assetDirectory: posix.join(
        source.directory,
        discovered.assetDirectory ?? DEFAULT_ASSET_DIRECTORY,
      ),
      sourcePathsByResource: paths,
    });
    diagnostics.push(
      ...discovered.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        ...(diagnostic.file ? { file: posix.join(source.directory, diagnostic.file) } : {}),
      })),
    );
    const previous = groups.get(source.directory);
    if (previous) {
      previous.discovered.resources.push(...discovered.resources);
      Object.assign(previous.discovered.sourcePathsByResource, discovered.sourcePathsByResource);
      previous.discovered.consumedSourcePaths.push(...discovered.consumedSourcePaths);
    } else {
      groups.set(source.directory, { source, discovered });
    }
  }
  throwOnCompileErrors(diagnostics);
  const compiled: DirectoryCompilation[] = [];
  for (const [directory, { source, discovered }] of groups) {
    try {
      const result = await compileAssetResources({
        rootDir: join(root, directory),
        resources: discovered.resources,
        sourcePathsByResource: discovered.sourcePathsByResource,
        protectedSourcePaths: [
          ...discovered.consumedSourcePaths,
          // Protect every manifest/config input reachable inside this local base.
          ...[TOPIK_MANIFEST_FILENAME, ...sources.map((entry) => entry.config)]
            .filter((path) => directory === "" || path.startsWith(`${directory}/`))
            .map((path) => (directory === "" ? path : path.slice(directory.length + 1))),
        ],
        sourceNamespace: source.sourceNamespace,
      });
      compiled.push({ directory, result });
    } catch (error) {
      if (error instanceof AssetCompilationError) {
        throw new AssetCompilationError(
          "Manifest source Asset compilation failed",
          error.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            ...(diagnostic.location?.path
              ? {
                  location: {
                    ...diagnostic.location,
                    path: posix.join(directory, diagnostic.location.path),
                  },
                }
              : {}),
          })),
        );
      }
      if (error instanceof CompileError) throw error;
      throw new ManifestSourceError(
        "manifest-source-failed",
        source.sourceIndex,
        source.kind,
        source.config,
      );
    }
  }
  return { diagnostics, provenance, ...mergeManifestCompilations(compiled) };
}

interface DirectoryCompilation {
  directory: string;
  result: AssetCompilationResult;
}

/** @internal Pure aggregation seam for collision tests; not exported from the package root. */
export function mergeManifestCompilations(
  groups: readonly DirectoryCompilation[],
): AssetCompilationResult {
  const byKey = new Map<string, { directory: string; resource: CompiledResource }>();
  const byPayload = new Map<string, AssetPayload>();
  for (const { directory, result } of groups) {
    for (const resource of result.resources) {
      const key = `${resource.type}/${resource.name}`;
      const previous = byKey.get(key);
      if (
        previous &&
        (resource.type !== "Asset" ||
          previous.directory !== directory ||
          serializeTopikJson(previous.resource) !== serializeTopikJson(resource))
      ) {
        throw new PublicCompileError("manifest-output-conflict");
      }
      byKey.set(key, { directory, resource });
    }
    for (const payload of result.payloads) {
      const previous = byPayload.get(payload.path);
      if (
        previous &&
        (previous.integrity !== payload.integrity ||
          previous.mediaType !== payload.mediaType ||
          previous.size !== payload.size ||
          !Buffer.from(previous.bytes).equals(payload.bytes))
      ) {
        throw new PublicCompileError("manifest-output-conflict");
      }
      byPayload.set(payload.path, {
        ...payload,
        assetNames: [...new Set([...(previous?.assetNames ?? []), ...payload.assetNames])].sort(
          compareUtf8,
        ),
      });
    }
  }
  const resources = [...byKey.values()]
    .map(({ resource }) => resource)
    .sort((left, right) => compareUtf8(`${left.type}/${left.name}`, `${right.type}/${right.name}`));
  const payloads = [...byPayload.values()].sort((left, right) =>
    compareUtf8(left.path, right.path),
  );
  const references = new Map(
    groups.flatMap(({ result }) =>
      result.semantic.references.map(
        (reference) => [serializeTopikJson(reference), reference] as const,
      ),
    ),
  );
  const semantic = createTopikAssetSemanticRecord(
    resources.filter((resource) => resource.type === "Asset"),
    [...references.values()],
  );
  const materialization = createTopikMaterializationRecord(
    resources.map((resource) => ({
      resource,
      bytes: new TextEncoder().encode(serializeTopikJson(resource)),
    })),
    payloads,
  );
  const validation = validateTopikMaterializationRecord(materialization, resources, semantic);
  if (!validation.ok)
    throw new AssetCompilationError("Manifest inventory is invalid", validation.diagnostics);
  return { resources, payloads, semantic, materialization };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
