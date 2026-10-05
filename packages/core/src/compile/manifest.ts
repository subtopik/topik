import { lstat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { DEFAULT_ASSET_DIRECTORY } from "../config/assets";
import {
  TOPIK_MANIFEST_FILENAME,
  topikManifestSchema,
  type TopikManifest,
  type TopikManifestSource,
} from "../config/manifest";
import { compileAssetResources } from "./assets";
import { createProjectAssetNameGenerator } from "./asset-names";
import { readConfigurationText, parseSafeConfigurationYaml, readExactConfigFile } from "./config";
import { discoverGuides, type CompileResourceDiscovery } from "./guide";
import { discoverWiki } from "./wiki";
import { PublicCompileError, type PublicCompileErrorId } from "./public-errors";
import { throwOnCompileErrors, type CompileResult } from "./shared";
import type { SourceResource } from "../resource";
import type { CompileOptions } from "./index";

export interface ManifestSourceDescriptor extends TopikManifestSource {
  /** Zero-based declaration index, used only for provenance and diagnostics. */
  sourceIndex: number;
  /** Canonical root-relative directory; empty for the project root. */
  directory: string;
  /** Project namespace declared in the manifest. */
  namespace: string;
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

/** Explicit loading requires the canonical file in exactly the supplied root. */
export async function loadTopikManifest(dir: string): Promise<TopikManifest> {
  try {
    await lstat(join(dir, TOPIK_MANIFEST_FILENAME));
  } catch (error) {
    throw new PublicCompileError(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "manifest-required"
        : "config-access-failed",
      TOPIK_MANIFEST_FILENAME,
    );
  }
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

export async function discoverManifestSources(
  options: CompileOptions,
): Promise<ManifestSourceDescriptor[]> {
  const manifest = await loadTopikManifest(options.dir);
  return manifestSourceDescriptors(manifest);
}

function manifestSourceDescriptors(manifest: TopikManifest): ManifestSourceDescriptor[] {
  return manifest.sources.map((source, sourceIndex) => {
    const parent = posix.dirname(source.config);
    const directory = parent === "." ? "" : parent;
    return {
      ...source,
      sourceIndex,
      directory,
      namespace: manifest.namespace,
    };
  });
}

/** Compile only declared sources, sharing the existing local compiler and Asset pipeline. */
export async function compileManifest(options: CompileOptions): Promise<ManifestCompileResult> {
  const root = resolve(options.dir);
  // Reject obsolete overrides from JavaScript callers instead of silently ignoring them.
  if ("assets" in options)
    throw new PublicCompileError("manifest-namespace-override", TOPIK_MANIFEST_FILENAME);
  const manifest = await loadTopikManifest(root);
  const sources = manifestSourceDescriptors(manifest);
  const provenance: ManifestSourceProvenance[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const resources: SourceResource[] = [];
  const sourcePathsByResource: Record<string, string> = {};
  const sourceDirectoriesByResource: Record<string, string> = {};
  const protectedSourcePaths = [TOPIK_MANIFEST_FILENAME, ...sources.map((source) => source.config)];
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
    resources.push(...discovered.resources);
    for (const [key, path] of Object.entries(discovered.sourcePathsByResource)) {
      sourcePathsByResource[key] = posix.join(source.directory, path);
      sourceDirectoriesByResource[key] = source.directory;
    }
    protectedSourcePaths.push(
      ...discovered.consumedSourcePaths.map((path) => posix.join(source.directory, path)),
    );
  }
  throwOnCompileErrors(diagnostics);
  const compiled = await compileAssetResources({
    rootDir: root,
    resources,
    sourcePathsByResource,
    sourceDirectoriesByResource,
    protectedSourcePaths,
    generateName: createProjectAssetNameGenerator({
      projectRoot: root,
      projectNamespace: manifest.namespace,
    }),
  });
  return { diagnostics, provenance, ...compiled };
}
