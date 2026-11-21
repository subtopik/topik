import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Guide } from "@topik/schema/guide/v1";
import type { SourceResource } from "../resource";
import {
  collectionGuideFilter,
  isReadmeFilename,
  isSkippedCollectionDirectory,
  parseCollectionConfig,
  type CollectionGuideFilter,
} from "../config/collection";
import { parseGuideMetadata } from "../config/source-metadata";
import { compileAssetResourcesInSession, type AssetCompilationOptions } from "./assets";
import { createPortableReadSession, type PortableReadSession } from "../assets/files";
import { createContentMemo, type ContentMemo } from "./content-memo";
import {
  readOptionalConfigFileWithPath,
  readExactConfigFile,
  configurationDirectory,
  type LoadedConfig,
} from "./config";
import {
  decodeUtf8Document,
  existingDocuments,
  FileNotRegularError,
  FileOutsideCompilationRootError,
  readRegularFileWithinRoot,
} from "./files";
import { PublicCompileError, publicSchemaError } from "./public-errors";
import {
  extractMarkdownTitle,
  parseMarkdownFrontmatter,
  withFileLines,
  throwOnCompileErrors,
  type CompileReadOptions,
  type CompileValidationOptions,
  type CompileResult,
} from "./shared";
import { compileResourceLinksInSession, type CompileResourceReferenceTarget } from "./links";
import { assertValidDocumentResource } from "./wiki";
import { RESOURCE_NAME_MAX_LENGTH, SLUG_PATTERN } from "../resource-names";

export interface CompileGuidesOptions extends CompileReadOptions {
  dir: string;
  /** Exact config path relative to dir; content is relative to the config directory. */
  configFile?: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
  referenceTargets?: readonly CompileResourceReferenceTarget[];
}

export interface CompileResourceDiscovery {
  /** Destination relative to the selected configuration directory, if a config was loaded. */
  assetDirectory?: string;
  diagnostics: CompileResult["diagnostics"];
  resources: SourceResource[];
  sourcePathsByResource: Record<string, string>;
  /** Lines before each document's body, by resource key, where there are any. */
  bodyLinesByResource?: Record<string, number>;
  /**
   * Documents whose content failed validation, with paths like `sourcePathsByResource`. They are
   * not resources; lint passes them to link checking only so that links to them still resolve.
   */
  unvalidatedDocuments?: { resource: SourceResource; sourcePath: string }[];
  consumedSourcePaths: string[];
}

export async function compileGuides(options: CompileGuidesOptions): Promise<CompileResult> {
  const result = await inspectGuides(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectGuides(options: CompileGuidesOptions): Promise<CompileResult> {
  const memo = createContentMemo();
  // One session shares Git repository evidence across every read of this call.
  const session = createPortableReadSession(options.fileSafety, options.gitExecutable);
  const discovered = await discoverGuides(options, undefined, memo, session);
  validateGuideAuthors(discovered.resources, discovered.sourcePathsByResource);
  const linked = await compileResourceLinksInSession(
    session,
    {
      rootDir: configurationDirectory(options.dir, options.configFile),
      resources: discovered.resources,
      sourcePathsByResource: discovered.sourcePathsByResource,
      bodyLinesByResource: discovered.bodyLinesByResource,
      validation: options.validation,
      referenceTargets: options.referenceTargets,
    },
    memo,
  );
  throwOnCompileErrors(linked.diagnostics);
  const compiled = await compileAssetResourcesInSession(
    session,
    {
      rootDir: configurationDirectory(options.dir, options.configFile),
      resources: linked.resources,
      sourcePathsByResource: discovered.sourcePathsByResource,
      protectedSourcePaths: discovered.consumedSourcePaths,
      ...options.assets,
    },
    memo,
  );
  return {
    diagnostics: [...discovered.diagnostics, ...linked.diagnostics],
    references: linked.references,
    ...compiled,
  };
}

/** @internal Discovery phase used by the mixed top-level compiler. */
export async function discoverGuides(
  options: CompileGuidesOptions,
  selectedConfig?: LoadedConfig,
  memo: ContentMemo = createContentMemo(),
  session: PortableReadSession = createPortableReadSession(
    options.fileSafety,
    options.gitExecutable,
  ),
): Promise<CompileResourceDiscovery> {
  const dir = configurationDirectory(options.dir, options.configFile);

  const loadedConfig =
    selectedConfig ??
    (options.configFile !== undefined
      ? await readExactConfigFile(options.dir, options.configFile, session)
      : await readOptionalConfigFileWithPath(
          dir,
          ["collection.yaml", "collection.yml", "collection.json"],
          session,
        ));
  if (loadedConfig == null) {
    return { diagnostics: [], resources: [], sourcePathsByResource: {}, consumedSourcePaths: [] };
  }

  let config;
  try {
    config = parseCollectionConfig(loadedConfig.value);
  } catch (error) {
    throw publicSchemaError("config-invalid", options.configFile ?? loadedConfig.path, error);
  }

  const { paths: markdownFiles, leftOut } = await collectionDocumentPaths(dir, config);

  const resources: SourceResource[] = [...(config.persons ?? [])];
  const diagnostics: CompileResult["diagnostics"] = leftOut.map((file) => ({
    id: "guide-left-out",
    type: "Guide",
    level: "warning",
    message:
      "A Markdown file named in capitals is not read as a guide. Rename it in lowercase to make it a guide, or exclude it.",
    lines: [],
    file,
  }));
  const sourcePathsByResource: Record<string, string> = {};
  const bodyLinesByResource: Record<string, number> = {};
  const unvalidatedDocuments: NonNullable<CompileResourceDiscovery["unvalidatedDocuments"]> = [];
  const claimedNames = new Map<string, string>();

  for (const file of markdownFiles) {
    const filePath = join(dir, file);
    let rawContent: string;
    try {
      rawContent = decodeUtf8Document(await readRegularFileWithinRoot(filePath, dir), file);
    } catch (error) {
      if (error instanceof FileOutsideCompilationRootError) {
        diagnostics.push({
          id: "guide-outside-compilation-root",
          type: "Guide",
          level: "error",
          message: "Guide files must resolve within the compilation directory",
          lines: [],
          file,
        });
        continue;
      }
      // A listed entry that vanished before it could be read is equally not a regular file.
      if (
        error instanceof FileNotRegularError ||
        (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ) {
        diagnostics.push({
          id: "guide-not-regular-file",
          type: "Guide",
          level: "error",
          message: "Guide entries must be regular files",
          lines: [],
          file,
        });
        continue;
      }
      throw error;
    }
    const parsed = parseMarkdownFrontmatter(rawContent, file);
    const { content } = parsed;
    let frontmatter;
    try {
      frontmatter = parseGuideMetadata(parsed.frontmatter);
    } catch (error) {
      throw publicSchemaError("frontmatter-invalid", file, error);
    }
    const explicitSlug = frontmatter.slug;
    const explicitName = frontmatter.id;
    const slug = explicitSlug ?? fileToSlug(file);
    const name = explicitName ?? `${config.id}-${fileToSlug(file)}`;
    // Filename-derived identities must already be valid resource names and slugs.
    if (
      (explicitSlug === undefined || explicitName === undefined) &&
      (!SLUG_PATTERN.test(fileToSlug(file)) ||
        (explicitName === undefined && name.length > RESOURCE_NAME_MAX_LENGTH))
    )
      throw new PublicCompileError("guide-name-invalid", file);
    const duplicate = claimedNames.get(name);
    if (duplicate !== undefined)
      throw new PublicCompileError("guide-duplicate", file, { relatedLocation: duplicate });
    claimedNames.set(name, file);
    const validation = memo.validate(content, file);
    diagnostics.push(...withFileLines(validation.diagnostics, parsed.bodyLineOffset));
    if (!validation.ok) {
      unvalidatedDocuments.push({
        sourcePath: file,
        resource: {
          apiVersion: "v1",
          type: "Guide",
          name,
          spec: { title: slug, slug, content: { format: "topik", value: content } },
        },
      });
      continue;
    }
    const analysis = memo.analyze(content, file);
    diagnostics.push(...withFileLines(analysis.diagnostics, parsed.bodyLineOffset));
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(content, slug, analysis.headings);

    const tags =
      frontmatter.inheritTags === false
        ? (frontmatter.tags ?? [])
        : mergeTags(config.tags, frontmatter.tags);
    const { authors, description } = frontmatter;
    const guide: Guide = {
      apiVersion: "v1",
      type: "Guide",
      name,
      ...(frontmatter.labels !== undefined ? { labels: frontmatter.labels } : {}),
      spec: {
        title,
        slug,
        ...(description !== undefined ? { description } : {}),
        ...(authors !== undefined ? { authors } : {}),
        ...(tags.length > 0 || frontmatter.tags !== undefined ? { tags } : {}),
        content: {
          format: "topik",
          value: content,
        },
      },
    };

    assertValidDocumentResource(guide, file);
    resources.push(guide);
    sourcePathsByResource[`Guide/${guide.name}`] = file;
    if (parsed.bodyLineOffset) bodyLinesByResource[`Guide/${guide.name}`] = parsed.bodyLineOffset;
  }

  return {
    diagnostics,
    resources,
    sourcePathsByResource,
    bodyLinesByResource,
    unvalidatedDocuments,
    consumedSourcePaths: [loadedConfig.path],
    assetDirectory: config.assets.directory,
  };
}

/** The files a collection reads as guides, relative to `dir` with `/`, in a stable order. */
async function collectionDocumentPaths(
  dir: string,
  config: ReturnType<typeof parseCollectionConfig>,
): Promise<{ paths: string[]; leftOut: string[] }> {
  const paths: string[] = [];
  const leftOut: string[] = [];
  const filter = collectionGuideFilter(config);
  for (const file of (await listGuideFiles(dir, "", filter, leftOut)).sort())
    if (!isReadmeFilename(file) || (await readmeDeclaresGuide(dir, file))) paths.push(file);
  return { paths, leftOut: leftOut.sort() };
}

/**
 * @internal The Markdown files a collection reads, whether or not their content is valid.
 * Reads no content except the frontmatter of a `README` beside the configuration.
 */
export async function listCollectionDocuments(
  dir: string,
  loaded: LoadedConfig,
): Promise<string[]> {
  let config;
  try {
    config = parseCollectionConfig(loaded.value);
  } catch (error) {
    throw publicSchemaError("config-invalid", loaded.path, error);
  }
  // Compilation reports an entry that is not a regular file; a list of documents omits it.
  return existingDocuments(dir, (await collectionDocumentPaths(dir, config)).paths);
}

/**
 * Paths of the collection's guide files, relative to `dir` with `/`. Directories are read only
 * when `include` names a path below `dir`; links to directories are never followed. An entry
 * with a Markdown name that is not a regular file is listed too, so reading it reports it.
 */
async function listGuideFiles(
  dir: string,
  relativeDir: string,
  filter: CollectionGuideFilter,
  leftOut: string[],
): Promise<string[]> {
  const entries = await readdir(relativeDir === "" ? dir : join(dir, relativeDir), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const path = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
    if (filter.matches(path)) files.push(path);
    else if (filter.nested && entry.isDirectory() && !isSkippedCollectionDirectory(entry.name))
      files.push(...(await listGuideFiles(dir, path, filter, leftOut)));
    else if (entry.isFile() && filter.leavesOutUnusualName(path)) leftOut.push(path);
  }
  return files;
}

/**
 * A `README` beside the configuration is usually the repository's readme, not Topik content,
 * and its name gives no slug. It is a guide only when its frontmatter sets both `id` and
 * `slug`; a link, bytes that do not decode or frontmatter that does not parse make it a file
 * to leave out. A `README` in a folder below is that folder's landing page and is always read.
 */
async function readmeDeclaresGuide(dir: string, file: string): Promise<boolean> {
  try {
    const raw = decodeUtf8Document(await readRegularFileWithinRoot(join(dir, file), dir), file);
    const { frontmatter } = parseMarkdownFrontmatter(raw, file);
    return typeof frontmatter.id === "string" && typeof frontmatter.slug === "string";
  } catch {
    return false;
  }
}

const LANDING_STEM = /^(?:index|readme)$/iu;

/**
 * Folders only organise files: the slug comes from the filename alone. The exception is a
 * folder's landing page, `index` or `readme` in any case below the configuration directory,
 * which takes the name of its folder, so each folder can have one.
 */
function fileToSlug(path: string): string {
  const stem = posix.basename(path).replace(/\.(mdx?|md)$/, "");
  const folder = posix.dirname(path);
  return folder !== "." && LANDING_STEM.test(stem) ? posix.basename(folder) : stem;
}

export { extractMarkdownTitle as extractTitle } from "./shared";

export function validateGuideAuthors(
  resources: readonly SourceResource[],
  paths: Readonly<Record<string, string>>,
): void {
  const persons = new Set(
    resources.filter((resource) => resource.type === "Person").map((resource) => resource.name),
  );
  for (const resource of resources)
    if (resource.type === "Guide" && resource.spec.authors?.some((author) => !persons.has(author)))
      throw new PublicCompileError("author-not-found", paths[`Guide/${resource.name}`]);
}

function mergeTags(collectionTags: readonly string[] = [], guideTags: readonly string[] = []) {
  return [...new Set([...collectionTags, ...guideTags])];
}
