import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import {
  compileManifest,
  type ManifestCompileResult,
  type ManifestSourceProvenance,
} from "../compile/manifest";
import { loadTopikManifest } from "../compile/manifest";
import type { TopikManifest } from "../config/manifest";
import { validateTopikPathSet } from "../assets/path";
import { serializeTopikJson } from "../assets/json";
import {
  FORMAT_VERSION,
  extractTopikAssetOccurrences,
  rewriteTopikNavigationReferences,
  type TopikNavigationReference,
} from "@topik/content";
import type { Wiki } from "@topik/schema/wiki/v1";
import type { Resource } from "../resource";
import { resolveWikiContentHref, resolveWikiNavigation } from "../wiki-navigation";
import { parseMarkdownFrontmatter } from "../compile/shared";
import corePackage from "../../package.json" with { type: "json" };
import {
  decodeSource,
  encodeSource,
  inspectSourceSyntax,
  sourceHash,
  type SourceByteRange,
  type SourceFieldEvidence,
} from "./syntax";

export const SOURCE_WRITER_VERSION = "topik-source-writer-v1" as const;
export const SOURCE_PROJECT_LIMITS = {
  maxFiles: 10_000,
  maxFileBytes: 268_435_456,
  maxTreeBytes: 536_870_912,
} as const;
export const SOURCE_WRITER_DESCRIPTOR = {
  writer: SOURCE_WRITER_VERSION,
  manifest: 1,
  sourceVersions: [0, 1],
  formatter: FORMAT_VERSION,
  resourceSchema: "v1",
  references: "wiki-source-links-v1",
  provenance: 3,
  graph: "authored-resource-bytes-v1",
  packageVersion: corePackage.version,
} as const;

export interface SourceTreeFile {
  path: string;
  mode: "100644" | "100755";
  bytes: Uint8Array;
}
export interface SourceDocumentProvenance {
  resource: string;
  apiVersion: Resource["apiVersion"];
  type: Resource["type"];
  name: string;
  path: string;
  config: string;
  kind: ManifestSourceProvenance["kind"];
  directory: string;
  sourceVersion?: 1;
  sha256: string;
  mode: SourceTreeFile["mode"];
  body?: SourceByteRange;
  frontmatter?: SourceByteRange;
  fields: readonly SourceFieldEvidence[];
  fieldOrigins: readonly SourceFieldOrigin[];
  /** Recognized legacy metadata whose compiled value would lose authored meaning. */
  lossyMetadata?: readonly string[];
  /** Context travels with immutable saved source; a later source move must not reinterpret it. */
  sourceContext: {
    path: string;
    extension: string;
    /** Key in SourceProject.wikiContexts; retain that snapshot with saved content. */
    wiki?: string;
  };
  references: readonly (TopikNavigationReference & {
    target?: string;
    search?: string;
    hash?: string;
  })[];
  /** Complete derived Asset identity closure for this compiled resource. */
  assetReferences: readonly string[];
}
export interface SourceFieldOrigin {
  field: string;
  origin: "explicit" | "derived" | "inherited" | "default";
  path?: string;
  selector?: string;
  range?: SourceByteRange;
}
export interface SourceConfigurationProvenance {
  path: string;
  sha256: string;
  mode: SourceTreeFile["mode"];
  fields: readonly SourceFieldEvidence[];
  insertion: number;
}
export interface SourceProject {
  tree: readonly SourceTreeFile[];
  treeDigest: string;
  manifest: TopikManifest;
  manifestSha256: string;
  compilation: ManifestCompileResult;
  documents: readonly SourceDocumentProvenance[];
  configurations: readonly SourceConfigurationProvenance[];
  wikiContexts: Readonly<Record<string, Wiki>>;
  descriptor: typeof SOURCE_WRITER_DESCRIPTOR;
}

/** A normalized complete tree is required; omitted paths never imply ownership or absence. */
export function snapshotSourceTree(input: readonly SourceTreeFile[]): SourceTreeFile[] {
  if (input.length > SOURCE_PROJECT_LIMITS.maxFiles)
    throw new TypeError("Source tree exceeds file limit");
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of input) {
    if (
      seen.has(file.path) ||
      (file.mode !== "100644" && file.mode !== "100755") ||
      !(file.bytes instanceof Uint8Array) ||
      file.bytes.length > SOURCE_PROJECT_LIMITS.maxFileBytes
    )
      throw new TypeError("Source tree requires unique regular files with bounded bytes");
    seen.add(file.path);
    bytes += file.bytes.length;
    if (bytes > SOURCE_PROJECT_LIMITS.maxTreeBytes)
      throw new TypeError("Source tree exceeds its aggregate byte limit");
  }
  if (!validateTopikPathSet(input.map((file) => file.path)).ok)
    throw new TypeError("Source tree exceeds limits or contains unsafe/colliding paths");
  const tree = input.map((file) => ({
    path: file.path,
    mode: file.mode,
    bytes: new Uint8Array(file.bytes),
  }));
  return tree.sort((left, right) =>
    Buffer.compare(encodeSource(left.path), encodeSource(right.path)),
  );
}
export function digestSourceTree(tree: readonly SourceTreeFile[]): string {
  return sourceHash(
    encodeSource(
      serializeTopikJson(
        snapshotSourceTree(tree).map((file) => ({
          path: file.path,
          mode: file.mode,
          size: file.bytes.length,
          sha256: sourceHash(file.bytes),
        })),
      ),
    ),
  );
}

/** Seal the exact desired authoring graph without parsing or formatting its content. */
export function digestSourceResourceGraph(resources: readonly Resource[]): string {
  return sourceHash(
    encodeSource(
      serializeTopikJson(resources.map((resource) => serializeTopikJson(resource)).sort()),
    ),
  );
}

export async function withSourceScratch<T>(
  tree: readonly SourceTreeFile[],
  action: (dir: string) => Promise<T>,
): Promise<T> {
  const snapshot = snapshotSourceTree(tree);
  const dir = await mkdtemp(join(tmpdir(), "topik-source-project-"));
  try {
    for (const file of snapshot) {
      const target = join(dir, file.path);
      await mkdir(posix.dirname(target), { recursive: true });
      await writeFile(target, file.bytes, {
        flag: "wx",
        mode: file.mode === "100755" ? 0o755 : 0o644,
      });
    }
    return await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function sourceMarkdownSections(bytes: Uint8Array) {
  const raw = decodeSource(bytes);
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { raw, body: raw, bodyRange: { start: 0, end: bytes.length } };
  const opening = raw.startsWith("---\r\n") ? 5 : 4;
  const end = encodeSource(match[0]).length;
  return {
    raw,
    body: raw.slice(match[0].length),
    bodyRange: { start: end, end: bytes.length },
    frontmatter: match[1],
    frontmatterRange: { start: opening, end: opening + encodeSource(match[1]).length },
  };
}

/** Inspection compiles exactly the manifest tree and retains original documents and byte ranges. */
export async function readSourceProject(input: {
  tree: readonly SourceTreeFile[];
}): Promise<SourceProject> {
  const tree = snapshotSourceTree(input.tree);
  const byPath = new Map(tree.map((file) => [file.path, file]));
  const { manifest, compilation } = await withSourceScratch(tree, async (dir) => ({
    manifest: await loadTopikManifest(dir),
    compilation: await compileManifest({ dir }),
  }));
  const configurations: SourceConfigurationProvenance[] = [];
  const configValues = new Map<string, Record<string, unknown>>();
  for (const path of [".topik.yaml", ...manifest.sources.map((source) => source.config)]) {
    const file = byPath.get(path)!;
    const syntax = inspectSourceSyntax(decodeSource(file.bytes), path.endsWith(".json"));
    configValues.set(path, syntax.value);
    const fields = [...syntax.fields.values()];
    if (path !== ".topik.yaml")
      for (const selector of [
        "sourceVersion",
        "title",
        "description",
        "labels",
        "navigation",
        "theme",
        "persons",
      ])
        if (!syntax.fields.has(selector)) fields.push({ selector, insertion: syntax.insertion });
    for (const [prefix, keys] of [
      ["theme/", ["colors", "appearance"]],
      ["theme/colors/", ["primary", "light", "dark"]],
      ["theme/appearance/", ["default"]],
    ] as const) {
      const map = syntax.maps.get(prefix);
      if (!map?.range) continue;
      const offset = encodeSource(
        decodeSource(file.bytes).slice(0, map.flow ? map.range[1] - 1 : map.range[1]),
      ).length;
      for (const key of keys)
        if (!syntax.fields.has(`${prefix}${key}`))
          fields.push({ selector: `${prefix}${key}`, insertion: offset });
    }
    configurations.push({
      path,
      sha256: sourceHash(file.bytes),
      mode: file.mode,
      fields,
      insertion: syntax.insertion,
    });
  }
  const documents: SourceDocumentProvenance[] = [];
  const wikiContexts: Record<string, Wiki> = Object.fromEntries(
    compilation.resources
      .filter((resource): resource is Wiki => resource.type === "Wiki")
      .map((wiki) => [`Wiki/${wiki.name}`, structuredClone(wiki)]),
  );
  const resources = new Map(
    compilation.resources.map((resource) => [`${resource.type}/${resource.name}`, resource]),
  );
  for (const source of compilation.provenance) {
    for (const [resource, path] of Object.entries(source.sourcePathsByResource)) {
      const file = byPath.get(path)!;
      if (!file) throw new TypeError("Compiler provenance is outside the source inventory");
      const portable = resources.get(resource)!;
      if (!portable) throw new TypeError("Compiler provenance has no resource");
      const wiki =
        portable.type === "WikiPage"
          ? compilation.resources.find(
              (candidate): candidate is Wiki =>
                candidate.type === "Wiki" && candidate.name === portable.spec.wiki,
            )
          : undefined;
      const base = {
        resource,
        apiVersion: portable.apiVersion,
        type: portable.type,
        name: portable.name,
        path,
        config: source.config,
        kind: source.kind,
        directory: source.directory,
        ...(configValues.get(source.config)?.sourceVersion === 1
          ? { sourceVersion: 1 as const }
          : {}),
        sha256: sourceHash(file.bytes),
        mode: file.mode,
        sourceContext: {
          path: posix.relative(source.directory, path),
          extension: posix.extname(path),
          ...(wiki ? { wiki: `Wiki/${wiki.name}` } : {}),
        },
        assetReferences:
          portable.type === "Guide" || portable.type === "WikiPage"
            ? [
                ...new Set(
                  extractTopikAssetOccurrences(portable.spec.content.value, {
                    includeGenericLinkCandidates: true,
                  })
                    .filter((occurrence) => occurrence.reference.startsWith("asset:"))
                    .map((occurrence) => occurrence.reference.slice(6)),
                ),
              ].sort()
            : [],
      };
      const configuration = configurations.find((config) => config.path === source.config)!;
      if (path === source.config) {
        documents.push({
          ...base,
          fields: [],
          fieldOrigins: configurationOrigins(portable, configuration),
          references: [],
        });
        continue;
      }
      const markdown = sourceMarkdownSections(file.bytes);
      let fields: SourceFieldEvidence[] = [];
      let metadata: Record<string, unknown> = {};
      if (markdown.frontmatter && markdown.frontmatterRange) {
        try {
          const syntax = inspectSourceSyntax(markdown.frontmatter);
          metadata = syntax.value;
          fields = [...syntax.fields.values()].map((field) => ({
            ...field,
            insertion: field.insertion + markdown.frontmatterRange!.start,
            ...(field.value
              ? {
                  value: {
                    start: field.value.start + markdown.frontmatterRange!.start,
                    end: field.value.end + markdown.frontmatterRange!.start,
                  },
                }
              : {}),
            ...(field.entry
              ? {
                  entry: {
                    start: field.entry.start + markdown.frontmatterRange!.start,
                    end: field.entry.end + markdown.frontmatterRange!.start,
                  },
                }
              : {}),
          }));
        } catch {
          /* Opaque legacy frontmatter stays intact; metadata edits must admit it separately. */
          metadata = parseMarkdownFrontmatter(markdown.raw, path, base.sourceVersion).frontmatter;
        }
      }
      documents.push({
        ...base,
        body: markdown.bodyRange,
        ...(base.sourceVersion !== 1 && (portable.type === "Guide" || portable.type === "WikiPage")
          ? {
              lossyMetadata: ["title", "description"].filter(
                (key) =>
                  Object.hasOwn(metadata, key) &&
                  metadata[key] !== (portable.spec as unknown as Record<string, unknown>)[key],
              ),
            }
          : {}),
        ...(markdown.frontmatterRange ? { frontmatter: markdown.frontmatterRange } : {}),
        fields,
        fieldOrigins: markdownOrigins(
          portable,
          base.sourceVersion,
          path,
          fields,
          metadata,
          markdown.bodyRange,
          configValues.get(source.config)!,
          configuration,
        ),
        references: wiki ? sourceReferences(markdown.body, portable.name, wiki) : [],
      });
    }
  }
  return {
    tree,
    treeDigest: digestSourceTree(tree),
    manifest,
    manifestSha256: sourceHash(byPath.get(".topik.yaml")!.bytes),
    compilation,
    documents,
    configurations,
    wikiContexts,
    descriptor: SOURCE_WRITER_DESCRIPTOR,
  };
}

function origin(
  field: string,
  kind: SourceFieldOrigin["origin"],
  path?: string,
  selector?: string,
  fields: readonly SourceFieldEvidence[] = [],
  range?: SourceByteRange,
): SourceFieldOrigin {
  const value = fields.find((evidence) => evidence.selector === selector)?.value;
  return {
    field,
    origin: kind,
    ...(path ? { path } : {}),
    ...(selector ? { selector } : {}),
    ...((value ?? range) ? { range: value ?? range } : {}),
  };
}

function configurationOrigins(
  resource: Resource,
  config: SourceConfigurationProvenance,
): SourceFieldOrigin[] {
  const prefix = resource.type === "Person" ? `persons/${encodeURIComponent(resource.name)}/` : "";
  const explicit = (field: string, selector: string) =>
    origin(
      field,
      config.fields.some((evidence) => evidence.selector === selector && evidence.value)
        ? "explicit"
        : "default",
      config.path,
      selector,
      config.fields,
    );
  const result = [
    explicit("name", `${prefix}id`),
    resource.type === "Person" || (resource.type === "Wiki" && resource.spec.sourceVersion === 1)
      ? explicit("labels", `${prefix}labels`)
      : origin("labels", "default"),
  ];
  for (const field of resource.type === "Person"
    ? ["name", "email", "bio"]
    : ["title", "description", "navigation", "theme", "sourceVersion"])
    result.push(
      explicit(
        `spec/${field}`,
        `${prefix}${resource.type === "Person" ? "spec/" : ""}${encodeURIComponent(field)}`,
      ),
    );
  return result;
}

function markdownOrigins(
  resource: Resource,
  sourceVersion: 1 | undefined,
  path: string,
  fields: readonly SourceFieldEvidence[],
  metadata: Record<string, unknown>,
  body: SourceByteRange,
  config: Record<string, unknown>,
  configuration: SourceConfigurationProvenance,
): SourceFieldOrigin[] {
  const has = (selector: string) =>
    fields.some((field) => field.selector === selector && field.value);
  const explicit = (field: string, selector: string, interpreted = true) =>
    origin(
      field,
      interpreted && Object.hasOwn(metadata, selector) ? "explicit" : "default",
      path,
      interpreted ? selector : undefined,
      fields,
    );
  const result = [
    origin(
      "name",
      sourceVersion === 1 && has("id") ? "explicit" : "derived",
      path,
      sourceVersion === 1 && has("id") ? "id" : undefined,
      fields,
    ),
    sourceVersion === 1 ? explicit("labels", "labels") : origin("labels", "default"),
    typeof metadata.title === "string"
      ? explicit("spec/title", "title")
      : origin("spec/title", "derived", path, undefined, [], body),
    explicit(
      "spec/description",
      "description",
      typeof metadata.description === "string" ||
        (sourceVersion === 1 && metadata.description === null),
    ),
    origin("spec/content", "explicit", path, undefined, [], body),
  ];
  if (resource.type === "WikiPage")
    result.push(origin("spec/wiki", "inherited", configuration.path, "id", configuration.fields));
  if (resource.type === "Guide") {
    result.push(
      sourceVersion === 1 && has("slug")
        ? explicit("spec/slug", "slug")
        : origin("spec/slug", "derived", path),
      explicit("spec/authors", "authors", resource.spec.authors !== undefined),
    );
    const inherited =
      Array.isArray(config.tags) && !(sourceVersion === 1 && metadata.inheritTags === false);
    if (inherited)
      result.push(
        origin("spec/tags", "inherited", configuration.path, "tags", configuration.fields),
      );
    const explicitTags = Array.isArray(metadata.tags);
    if (explicitTags) result.push(explicit("spec/tags", "tags"));
    if (!inherited && !explicitTags) result.push(origin("spec/tags", "default"));
  }
  return result;
}

function sourceReferences(
  source: string,
  name: string,
  wiki: Wiki,
): SourceDocumentProvenance["references"] {
  const resolved = resolveWikiNavigation(wiki.spec.navigation ?? [], {
    sourceVersion: wiki.spec.sourceVersion,
  });
  const references: Array<
    TopikNavigationReference & { target?: string; search?: string; hash?: string }
  > = [];
  const inspected = rewriteTopikNavigationReferences(source, (reference) => {
    const target = resolveWikiContentHref(reference.href, name, resolved);
    references.push({
      ...reference,
      ...(target
        ? { target: `WikiPage/${target.page.page}`, search: target.search, hash: target.hash }
        : {}),
    });
    return undefined;
  });
  if (!inspected.ok) throw new TypeError("Source reference provenance cannot be inspected");
  return references;
}
