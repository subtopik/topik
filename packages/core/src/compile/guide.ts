import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Guide } from "@topik/schema/guide/v1";
import type { SourceResource } from "../resource";
import { parseCollectionConfig } from "../config/collection";
import { parseGuideMetadata } from "../config/source-version";
import { compileAssetResourcesInSession, type AssetCompilationOptions } from "./assets";
import { createPortableReadSession } from "../assets/files";
import { createContentMemo, type ContentMemo } from "./content-memo";
import {
  readOptionalConfigFileWithPath,
  readExactConfigFile,
  configurationDirectory,
  type LoadedConfig,
} from "./config";
import {
  decodeUtf8Document,
  FileNotRegularError,
  FileOutsideCompilationRootError,
  readRegularFileWithinRoot,
} from "./files";
import { PublicCompileError, publicSchemaError } from "./public-errors";
import {
  extractMarkdownTitle,
  parseMarkdownFrontmatter,
  parseReferenceList,
  throwOnCompileErrors,
  type CompileValidationOptions,
  type CompileResult,
} from "./shared";
import { compileResourceLinksInSession, type CompileResourceReferenceTarget } from "./links";
import { assertValidDocumentResource } from "./wiki";

/**
 * Instructions for coding agents, which `topik init` and `topik migrate` write beside the
 * project manifest. A collection in that directory does not read the file as a guide. Its
 * name could never be a guide's: guide filenames are lowercase.
 */
const AGENT_INSTRUCTIONS_FILENAME = "AGENTS.md";

export interface CompileGuidesOptions {
  dir: string;
  /** Exact config path relative to dir; content is relative to the config directory. */
  configFile?: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
  referenceTargets?: readonly CompileResourceReferenceTarget[];
}

export interface CompileResourceDiscovery {
  courseNavigation?: import("../preview").CourseNavigationIndex;
  sourceVersion?: 1;
  /** Destination relative to the selected configuration directory, if a config was loaded. */
  assetDirectory?: string;
  diagnostics: CompileResult["diagnostics"];
  resources: SourceResource[];
  sourcePathsByResource: Record<string, string>;
  consumedSourcePaths: string[];
}

export async function compileGuides(options: CompileGuidesOptions): Promise<CompileResult> {
  const result = await inspectGuides(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectGuides(options: CompileGuidesOptions): Promise<CompileResult> {
  const memo = createContentMemo();
  const discovered = await discoverGuides(options, undefined, memo);
  if (discovered.sourceVersion === 1)
    validateGuideAuthors(discovered.resources, discovered.sourcePathsByResource);
  const linked = await compileResourceLinksInSession(
    createPortableReadSession(),
    {
      rootDir: configurationDirectory(options.dir, options.configFile),
      resources: discovered.resources,
      sourcePathsByResource: discovered.sourcePathsByResource,
      validation: options.validation,
      referenceTargets: options.referenceTargets,
    },
    memo,
  );
  throwOnCompileErrors(linked.diagnostics);
  const compiled = await compileAssetResourcesInSession(
    createPortableReadSession(),
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
    courseNavigation: {},
    ...compiled,
  };
}

/** @internal Discovery phase used by the mixed top-level compiler. */
export async function discoverGuides(
  options: CompileGuidesOptions,
  selectedConfig?: LoadedConfig,
  memo: ContentMemo = createContentMemo(),
): Promise<CompileResourceDiscovery> {
  const dir = configurationDirectory(options.dir, options.configFile);

  const loadedConfig =
    selectedConfig ??
    (options.configFile !== undefined
      ? await readExactConfigFile(options.dir, options.configFile)
      : await readOptionalConfigFileWithPath(dir, [
          "collection.yaml",
          "collection.yml",
          "collection.json",
        ]));
  if (loadedConfig == null) {
    return { diagnostics: [], resources: [], sourcePathsByResource: {}, consumedSourcePaths: [] };
  }

  let config;
  try {
    config = parseCollectionConfig(loadedConfig.value);
  } catch (error) {
    throw publicSchemaError("config-invalid", options.configFile ?? loadedConfig.path, error);
  }

  const files = await readdir(dir);
  const markdownFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx")).sort();
  const agentInstructions = markdownFiles.indexOf(AGENT_INSTRUCTIONS_FILENAME);
  if (
    agentInstructions !== -1 &&
    !(config.sourceVersion === 1 && (await agentInstructionsDeclareGuide(dir)))
  )
    markdownFiles.splice(agentInstructions, 1);

  const resources: SourceResource[] = [...(config.persons ?? [])];
  const diagnostics: CompileResult["diagnostics"] = [];
  const sourcePathsByResource: Record<string, string> = {};
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
    const parsed = parseMarkdownFrontmatter(rawContent, file, config.sourceVersion);
    const { content } = parsed;
    let frontmatter = parsed.frontmatter;
    if (config.sourceVersion === 1) {
      try {
        frontmatter = parseGuideMetadata(frontmatter);
      } catch (error) {
        throw publicSchemaError("frontmatter-invalid", file, error);
      }
    }
    const explicitSlug =
      config.sourceVersion === 1 && typeof frontmatter.slug === "string"
        ? frontmatter.slug
        : undefined;
    const explicitName =
      config.sourceVersion === 1 && typeof frontmatter.id === "string" ? frontmatter.id : undefined;
    const slug = explicitSlug ?? fileToSlug(file);
    const name = explicitName ?? `${config.id}-${fileToSlug(file)}`;
    // Filename-derived identities must already be valid resource names and slugs.
    if (
      (explicitSlug === undefined || explicitName === undefined) &&
      (!GUIDE_SLUG_PATTERN.test(fileToSlug(file)) ||
        (explicitName === undefined && name.length > GUIDE_NAME_MAX_LENGTH))
    )
      throw new PublicCompileError("guide-name-invalid", file);
    const duplicate = claimedNames.get(name);
    if (duplicate !== undefined)
      throw new PublicCompileError("guide-duplicate", file, { relatedLocation: duplicate });
    claimedNames.set(name, file);
    const validation = memo.validate(content, file);
    diagnostics.push(...validation.errors);
    if (!validation.valid) continue;
    const analysis = memo.analyze(content, file);
    diagnostics.push(...analysis.diagnostics);
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(content, slug, analysis.headings);

    const tags =
      config.sourceVersion === 1 && frontmatter.inheritTags === false
        ? ((frontmatter.tags as string[] | undefined) ?? [])
        : mergeTags(config.tags, frontmatter.tags);
    const authors =
      config.sourceVersion === 1
        ? (frontmatter.authors as string[] | undefined)
        : parseReferenceList(frontmatter.authors, "authors", file);
    const description =
      typeof frontmatter.description === "string" ||
      (config.sourceVersion === 1 && frontmatter.description === null)
        ? frontmatter.description
        : undefined;
    const guide: Guide = {
      apiVersion: "v1",
      type: "Guide",
      name,
      ...(config.sourceVersion === 1 && frontmatter.labels !== undefined
        ? { labels: frontmatter.labels as Record<string, string> }
        : {}),
      spec: {
        title,
        slug,
        ...(description !== undefined ? { description } : {}),
        ...(authors !== undefined ? { authors } : {}),
        ...(tags.length > 0 || (config.sourceVersion === 1 && frontmatter.tags !== undefined)
          ? { tags }
          : {}),
        content: {
          format: "topik",
          value: content,
        },
      },
    };

    assertValidDocumentResource(guide, file);
    resources.push(guide);
    sourcePathsByResource[`Guide/${guide.name}`] = file;
  }

  return {
    diagnostics,
    resources,
    sourcePathsByResource,
    consumedSourcePaths: [loadedConfig.path],
    assetDirectory: config.assets.directory,
    sourceVersion: config.sourceVersion,
  };
}

/**
 * `AGENTS.md` holds instructions for coding agents and is left out of the collection. It was a
 * guide before only when its frontmatter set both `id` and `slug`, because its filename gives
 * neither; such a file stays a guide, so no guide disappears from a collection without notice.
 */
async function agentInstructionsDeclareGuide(dir: string): Promise<boolean> {
  try {
    const raw = decodeUtf8Document(
      await readRegularFileWithinRoot(join(dir, AGENT_INSTRUCTIONS_FILENAME), dir),
      AGENT_INSTRUCTIONS_FILENAME,
    );
    const { frontmatter } = parseMarkdownFrontmatter(raw, AGENT_INSTRUCTIONS_FILENAME, 1);
    return typeof frontmatter.id === "string" && typeof frontmatter.slug === "string";
  } catch {
    // A link, unreadable bytes or frontmatter that does not parse: not a guide, so left out.
    return false;
  }
}

function fileToSlug(filename: string): string {
  return filename.replace(/\.(mdx?|md)$/, "");
}

const GUIDE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GUIDE_NAME_MAX_LENGTH = 63;

export { extractMarkdownTitle as extractTitle } from "./shared";

export function validateGuideAuthors(
  resources: readonly SourceResource[],
  paths: Readonly<Record<string, string>>,
  guideNames?: ReadonlySet<string>,
): void {
  const persons = new Set(
    resources.filter((resource) => resource.type === "Person").map((resource) => resource.name),
  );
  for (const resource of resources)
    if (
      resource.type === "Guide" &&
      (!guideNames || guideNames.has(resource.name)) &&
      resource.spec.authors?.some((author) => !persons.has(author))
    )
      throw new PublicCompileError("author-not-found", paths[`Guide/${resource.name}`]);
}

function mergeTags(collectionTags: string[] | undefined, frontmatterTags: unknown): string[] {
  const tags = new Set<string>();
  if (collectionTags) {
    for (const tag of collectionTags) {
      tags.add(tag);
    }
  }
  if (Array.isArray(frontmatterTags)) {
    for (const tag of frontmatterTags) {
      if (typeof tag === "string") {
        tags.add(tag);
      }
    }
  }
  return [...tags];
}
