import { lstat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { DEFAULT_ASSET_DIRECTORY } from "../config/assets";
import {
  TOPIK_MANIFEST_FILENAME,
  topikManifestSchema,
  type TopikManifest,
  type TopikManifestSource,
} from "../config/manifest";
import {
  createPortableReadSession,
  refusesProjectFileReads,
  type PortableReadSession,
} from "../assets/files";
import { compileAssetResourcesInSession } from "./assets";
import { createProjectAssetNameGenerator } from "./asset-names";
import { readConfigurationText, parseSafeConfigurationYaml, readExactConfigFile } from "./config";
import { discoverGuides, validateGuideAuthors, type CompileResourceDiscovery } from "./guide";
import { discoverWiki } from "./wiki";
import { discoverCourse, validateCourseAuthors } from "./course";
import {
  PublicCompileError,
  type PublicCompileErrorId,
  type PublicCompileErrorOptions,
} from "./public-errors";
import { throwOnCompileErrors, type CompileResult } from "./shared";
import type { SourceResource } from "../resource";
import type { CompileOptions } from "./index";
import { compileResourceLinksInSession } from "./links";
import { createContentMemo } from "./content-memo";

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
    options?: PublicCompileErrorOptions,
  ) {
    super(id, config, options);
    this.name = "ManifestSourceError";
    this.sourceIndex = sourceIndex;
    this.kind = kind;
  }
}

function manifestSourceFailure(
  error: unknown,
  source: ManifestSourceDescriptor,
  directory: string,
): ManifestSourceError {
  if (!(error instanceof PublicCompileError))
    return new ManifestSourceError(
      "manifest-source-failed",
      source.sourceIndex,
      source.kind,
      source.config,
      { cause: error },
    );
  return new ManifestSourceError(
    error.id,
    source.sourceIndex,
    source.kind,
    error.location === undefined ? source.config : posix.join(directory, error.location),
    {
      cause: error,
      field: error.field,
      reason: error.reason,
      relatedLocation:
        error.relatedLocation === undefined
          ? undefined
          : posix.join(directory, error.relatedLocation),
    },
  );
}

/** Explicit loading requires the canonical file in exactly the supplied root. */
export async function loadTopikManifest(dir: string): Promise<TopikManifest> {
  return loadTopikManifestInSession(dir, createPortableReadSession());
}

async function loadTopikManifestInSession(
  dir: string,
  session: PortableReadSession,
): Promise<TopikManifest> {
  // Refuse the platform before looking for the manifest, so its absence cannot hide that
  // no project file is readable here (and `dev` does not serve a project it can never read).
  if (refusesProjectFileReads(session.fileSafety)) {
    throw new PublicCompileError("config-read-failed", TOPIK_MANIFEST_FILENAME, {
      reason: "platform-unsupported",
    });
  }
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
  const raw = await readConfigurationText(dir, TOPIK_MANIFEST_FILENAME, session);
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
      const kind =
        entry.kind === "wiki" || entry.kind === "collection" || entry.kind === "course"
          ? entry.kind
          : undefined;
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
  // One session shares Git repository evidence across every portable read of this build.
  const session = createPortableReadSession(options.fileSafety, options.gitExecutable);
  // Repeated admission and analysis of the same document text is shared within this call only.
  const memo = createContentMemo();
  const manifest = await loadTopikManifestInSession(root, session);
  const sources = manifestSourceDescriptors(manifest);
  const provenance: ManifestSourceProvenance[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const resources: SourceResource[] = [];
  const courseNavigation: CompileResult["courseNavigation"] = {};
  const sourcePathsByResource: Record<string, string> = {};
  const sourceDirectoriesByResource: Record<string, string> = {};
  const protectedSourcePaths = [TOPIK_MANIFEST_FILENAME, ...sources.map((source) => source.config)];
  const authoredKeys = new Set<string>();
  const versionedGuideNames = new Set<string>();

  for (const source of sources) {
    let discovered: CompileResourceDiscovery;
    let selected;
    try {
      // Read against the project root so every config path component is checked.
      selected = await readExactConfigFile(root, source.config, session);
    } catch (error) {
      throw manifestSourceFailure(error, source, "");
    }
    try {
      const localOptions = { dir: join(root, source.directory), validation: options.validation };
      discovered = await (source.kind === "wiki"
        ? discoverWiki(localOptions, selected, memo)
        : source.kind === "course"
          ? discoverCourse(localOptions, selected, memo)
          : discoverGuides(localOptions, selected, memo));
    } catch (error) {
      // Discovery locations are relative to the source's configuration directory.
      throw manifestSourceFailure(error, source, source.directory);
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
    Object.assign(courseNavigation, discovered.courseNavigation);
    if (discovered.sourceVersion === 1)
      for (const resource of discovered.resources)
        if (resource.type === "Guide") versionedGuideNames.add(resource.name);
    for (const [key, path] of Object.entries(discovered.sourcePathsByResource)) {
      sourcePathsByResource[key] = posix.join(source.directory, path);
      sourceDirectoriesByResource[key] = source.directory;
    }
    protectedSourcePaths.push(
      ...discovered.consumedSourcePaths.map((path) => posix.join(source.directory, path)),
    );
  }
  throwOnCompileErrors(diagnostics);
  validateGuideAuthors(resources, sourcePathsByResource, versionedGuideNames);
  validateCourseAuthors(
    resources,
    Object.assign({}, ...provenance.map((source) => source.sourcePathsByResource)),
  );
  const linked = await compileResourceLinksInSession(
    session,
    {
      rootDir: root,
      resources,
      sourcePathsByResource,
      sourceDirectoriesByResource,
      validation: options.validation,
      referenceTargets: options.referenceTargets,
    },
    memo,
  );
  diagnostics.push(...linked.diagnostics);
  throwOnCompileErrors(diagnostics);
  const compiled = await compileAssetResourcesInSession(
    session,
    {
      rootDir: root,
      resources: linked.resources,
      sourcePathsByResource,
      sourceDirectoriesByResource,
      protectedSourcePaths,
      generateName: createProjectAssetNameGenerator({
        projectRoot: root,
        projectNamespace: manifest.namespace,
      }),
    },
    memo,
  );
  return { diagnostics, references: linked.references, provenance, courseNavigation, ...compiled };
}
