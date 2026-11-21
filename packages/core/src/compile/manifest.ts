import { sanitizeTopikContentDiagnostic } from "@topik/content";
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
import {
  AssetCompilationError,
  AssetFailuresCollected,
  compileAssetResourcesInSession,
  type AssetCompilationFailure,
} from "./assets";
import { createProjectAssetNameGenerator } from "./asset-names";
import { readConfigurationText, parseSafeConfigurationYaml, readExactConfigFile } from "./config";
import {
  discoverGuides,
  listCollectionDocuments,
  validateGuideAuthors,
  type CompileResourceDiscovery,
} from "./guide";
import { discoverWiki, listWikiDocuments } from "./wiki";
import { discoverCourse, listCourseDocuments, validateCourseAuthors } from "./course";
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

/**
 * The Markdown files the declared sources read, relative to the project directory with `/`,
 * sorted and without repeats. A file is listed whether or not its content is valid, so a tool
 * such as a formatter sees every project document. The list comes from the configurations and
 * directory listings: no document content is read, except the frontmatter of a `README` beside
 * a collection configuration. A page a configuration names that does not exist as a regular
 * file is left out. Fails as compilation does when the manifest or a configuration is invalid.
 */
export async function listManifestDocuments(
  options: Pick<CompileOptions, "dir" | "fileSafety" | "gitExecutable">,
): Promise<string[]> {
  const root = resolve(options.dir);
  const session = createPortableReadSession(options.fileSafety, options.gitExecutable);
  const manifest = await loadTopikManifestInSession(root, session);
  const documents = new Set<string>();
  for (const source of manifestSourceDescriptors(manifest)) {
    let selected;
    try {
      selected = await readExactConfigFile(root, source.config, session);
    } catch (error) {
      throw manifestSourceFailure(error, source, "");
    }
    try {
      const dir = join(root, source.directory);
      const paths = await (source.kind === "wiki"
        ? listWikiDocuments(dir, selected)
        : source.kind === "course"
          ? listCourseDocuments(dir, selected)
          : listCollectionDocuments(dir, selected));
      for (const path of paths) documents.add(posix.join(source.directory, path));
    } catch (error) {
      throw manifestSourceFailure(error, source, source.directory);
    }
  }
  return [...documents].sort();
}

/** Compile only declared sources, sharing the existing local compiler and Asset pipeline. */
export async function compileManifest(options: CompileOptions): Promise<ManifestCompileResult> {
  return (await runManifest(options)).compiled!;
}

/**
 * @internal A failure that stopped part of a lint: a source that could not be read or
 * discovered, a check across sources, or an Asset, with the documents it was found in.
 */
export interface ManifestLintFailure {
  error: unknown;
  /** Project-relative paths of the documents that reference a failed Asset. */
  documents?: readonly string[];
}

/**
 * @internal Check every declared source and report every problem found, rather than stopping at
 * the first stage with an error. A failing source is recorded and the others are still checked.
 * Pages whose content is invalid stay link targets, so links to them are not reported as missing.
 * Link and Asset checks are skipped once a source failed, since links into it cannot be judged.
 * A manifest that cannot be loaded still throws.
 */
export async function lintManifest(
  options: CompileOptions,
): Promise<{ diagnostics: CompileResult["diagnostics"]; failures: ManifestLintFailure[] }> {
  const failures: ManifestLintFailure[] = [];
  const { diagnostics } = await runManifest(options, failures);
  // The same fixed public wording and safe labels a CompileError carries.
  return { diagnostics: diagnostics.map(sanitizeTopikContentDiagnostic), failures };
}

/** The compile stages; with `failures`, they collect problems instead of stopping at the first. */
async function runManifest(
  options: CompileOptions,
  failures?: ManifestLintFailure[],
): Promise<{ diagnostics: CompileResult["diagnostics"]; compiled?: ManifestCompileResult }> {
  const collect = (error: unknown) => {
    if (failures === undefined) throw error;
    failures.push({ error });
  };
  const root = resolve(options.dir);
  // One session shares Git repository evidence across every portable read of this build.
  const session = createPortableReadSession(options.fileSafety, options.gitExecutable);
  // Repeated admission and analysis of the same document text is shared within this call, and
  // with earlier calls when the caller keeps a memo across them.
  const memo = options.contentMemo ?? createContentMemo();
  const manifest = await loadTopikManifestInSession(root, session);
  const sources = manifestSourceDescriptors(manifest);
  const provenance: ManifestSourceProvenance[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const resources: SourceResource[] = [];
  const sourcePathsByResource: Record<string, string> = {};
  const bodyLinesByResource: Record<string, number> = {};
  const sourceDirectoriesByResource: Record<string, string> = {};
  const protectedSourcePaths = [TOPIK_MANIFEST_FILENAME, ...sources.map((source) => source.config)];
  const authoredKeys = new Set<string>();
  const versionedGuideNames = new Set<string>();
  const unvalidatedDocuments: NonNullable<CompileResourceDiscovery["unvalidatedDocuments"]> = [];

  for (const source of sources) {
    let discovered: CompileResourceDiscovery;
    let selected;
    try {
      // Read against the project root so every config path component is checked.
      selected = await readExactConfigFile(root, source.config, session);
    } catch (error) {
      collect(manifestSourceFailure(error, source, ""));
      continue;
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
      collect(manifestSourceFailure(error, source, source.directory));
      continue;
    }
    const paths: Record<string, string> = {};
    const conflict = discovered.resources.some((resource) =>
      authoredKeys.has(`${resource.type}/${resource.name}`),
    );
    if (conflict) {
      collect(
        new ManifestSourceError(
          "manifest-resource-conflict",
          source.sourceIndex,
          source.kind,
          source.config,
        ),
      );
      continue;
    }
    for (const resource of discovered.resources) {
      const key = `${resource.type}/${resource.name}`;
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
    if (discovered.sourceVersion === 1)
      for (const resource of discovered.resources)
        if (resource.type === "Guide") versionedGuideNames.add(resource.name);
    Object.assign(bodyLinesByResource, discovered.bodyLinesByResource);
    for (const document of discovered.unvalidatedDocuments ?? []) {
      const key = `${document.resource.type}/${document.resource.name}`;
      if (authoredKeys.has(key)) continue;
      unvalidatedDocuments.push({
        resource: document.resource,
        sourcePath: posix.join(source.directory, document.sourcePath),
      });
      sourceDirectoriesByResource[key] = source.directory;
    }
    for (const [key, path] of Object.entries(discovered.sourcePathsByResource)) {
      sourcePathsByResource[key] = posix.join(source.directory, path);
      sourceDirectoriesByResource[key] = source.directory;
    }
    protectedSourcePaths.push(
      ...discovered.consumedSourcePaths.map((path) => posix.join(source.directory, path)),
    );
  }
  if (failures === undefined) throwOnCompileErrors(diagnostics);
  try {
    validateGuideAuthors(resources, sourcePathsByResource, versionedGuideNames);
  } catch (error) {
    collect(error);
  }
  try {
    validateCourseAuthors(
      resources,
      Object.assign({}, ...provenance.map((source) => source.sourcePathsByResource)),
    );
  } catch (error) {
    collect(error);
  }
  // Links into a source that failed cannot be judged, so a lint stops before them.
  if (failures?.some((failure) => failure.error instanceof ManifestSourceError))
    return { diagnostics };
  let linked;
  try {
    linked = await compileResourceLinksInSession(
      session,
      {
        rootDir: root,
        resources,
        sourcePathsByResource,
        sourceDirectoriesByResource,
        bodyLinesByResource,
        // Compilation stops before here when any document failed validation.
        ...(failures === undefined ? {} : { unvalidatedDocuments }),
        validation: options.validation,
        referenceTargets: options.referenceTargets,
      },
      memo,
    );
  } catch (error) {
    collect(error);
    return { diagnostics };
  }
  diagnostics.push(...linked.diagnostics);
  if (failures === undefined) throwOnCompileErrors(diagnostics);
  const assetFailures: AssetCompilationFailure[] = [];
  let compiled;
  try {
    compiled = await compileAssetResourcesInSession(
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
        ...(failures === undefined ? {} : { failures: assetFailures }),
      },
      memo,
    );
  } catch (error) {
    if (failures === undefined) throw error;
    failures.push(...assetFailures);
    if (!(error instanceof AssetFailuresCollected)) {
      if (!(error instanceof AssetCompilationError)) throw error;
      failures.push({ error });
    }
    return { diagnostics };
  }
  return {
    diagnostics,
    compiled: {
      diagnostics,
      references: linked.references,
      provenance,
      ...compiled,
    },
  };
}
