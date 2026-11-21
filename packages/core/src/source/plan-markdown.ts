import { posix } from "node:path";
import { formatTopikContent, rewriteTopikAssetOccurrences } from "@topik/content";
import type { Guide } from "@topik/schema/guide/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import type { Resource } from "../resource";
import { serializeTopikJson } from "../assets/json";
import { validateTopikPathSet } from "../assets/path";
import { extractMarkdownTitle } from "../compile/shared";
import { failSourcePlan as block } from "./diagnostics";
import { collectMetadataEdits } from "./metadata";
import { sourceMarkdownSections, type SourceProject, type SourceTreeFile } from "./project";
import { encodeSource, patchFrontmatterFields, sourceHash } from "./syntax";

/** A resource with a Markdown source document. */
export type WritableDocument = Guide | WikiPage | CoursePage;
export const resourceKey = (resource: Resource): string => `${resource.type}/${resource.name}`;

/** How a planner treats a derived document path that is occupied. */
export type SourcePathCollisionPolicy = "rename" | "refuse";

/** The identity a new document's derived path depends on. */
export type SourceDocumentIdentity =
  | { type: "Guide" | "CoursePage"; name: string; spec: { slug: string } }
  | { type: "WikiPage"; name: string };

/**
 * The two paths a planner can derive for a new document without an explicit path, in the
 * order it tries them: `<directory>/<slug>.md`, then the same name with a hyphen and the first
 * eight hexadecimal digits of the SHA-256 of the resource name. A Guide or Course page uses
 * its slug, a Wiki page its name, and an empty slug becomes `index`.
 */
export function sourceDocumentPathCandidates(
  directory: string,
  resource: SourceDocumentIdentity,
): readonly [plain: string, renamed: string] {
  const slug = resource.type === "WikiPage" ? resource.name : resource.spec.slug;
  const stem = posix.join(directory, slug || "index");
  return [`${stem}.md`, `${stem}-${sourceHash(encodeSource(resource.name)).slice(0, 8)}.md`];
}

/**
 * The path `planSourceUpdates` gives a new document created without an explicit `path`.
 * `occupied` is every path of the project tree plus the paths already given to earlier
 * operations of the same plan, in operation order: the result depends on both. Returns
 * `undefined` when no candidate is free and portable beside the occupied paths. With
 * `pathCollisions: "refuse"` only the plain path is a candidate.
 */
export function newSourceDocumentPath(input: {
  /** Manifest-relative directory of the source configuration; empty for the project root. */
  directory: string;
  resource: SourceDocumentIdentity;
  occupied: Iterable<string>;
  pathCollisions?: SourcePathCollisionPolicy;
}): string | undefined {
  const occupied = [...input.occupied];
  const taken = new Set(occupied);
  const candidates = sourceDocumentPathCandidates(input.directory, input.resource);
  for (const candidate of input.pathCollisions === "refuse" ? candidates.slice(0, 1) : candidates)
    if (!taken.has(candidate) && validateTopikPathSet([...occupied, candidate]).ok)
      return candidate;
  return undefined;
}

/**
 * The path `initializeSourceProject` and `addSourceToProject` derive for a new document that
 * has no entry in `documentPaths`. `directory` is the manifest-relative directory of the new
 * source configuration, empty for the project root.
 *
 * - `collection`: `<directory>/<slug>.md`. A later Guide of the same call that derives the
 *   same path gets the renamed candidate of {@link sourceDocumentPathCandidates} instead,
 *   or is refused with `pathCollisions: "refuse"`.
 * - `wiki`: `<directory>/<sourcePath>.md`, from the page's navigation entry. `documentPaths`
 *   does not apply to Wiki pages.
 * - `course`: `<directory>/<module slug>/<page slug>.md`.
 *
 * An occupied derived path is never renamed against the existing tree: it fails.
 */
export function initialSourceDocumentPath(
  input:
    | { kind: "collection"; directory: string; slug: string }
    | { kind: "wiki"; directory: string; sourcePath: string }
    | { kind: "course"; directory: string; moduleSlug: string; slug: string },
): string {
  if (input.kind === "wiki") return posix.join(input.directory, `${input.sourcePath}.md`);
  if (input.kind === "course")
    return posix.join(input.directory, input.moduleSlug, `${input.slug}.md`);
  return posix.join(input.directory, `${input.slug}.md`);
}

/**
 * The path a planner writes new media to: `<assetDirectory>/<stem>-<hash><extension>`, where
 * the hash is the first eight hexadecimal digits of the SHA-256 of the Asset name in the
 * selection. `assetDirectory` is manifest-relative: for `planSourceUpdates` the
 * `assetDirectory` that source provenance reports for the configuration, and for a source
 * being initialized or added its configuration directory joined with the intent's
 * `assetDirectory`, which defaults to `_assets`.
 */
export function sourceMediaPath(input: {
  assetDirectory: string;
  /** The selection's portable leaf filename. */
  filename: string;
  /** The selection's Asset name. */
  name: string;
}): string {
  const extension = posix.extname(input.filename);
  const stem = input.filename.slice(0, input.filename.length - extension.length);
  return posix.join(
    input.assetDirectory,
    `${stem}-${sourceHash(encodeSource(input.name)).slice(0, 8)}${extension}`,
  );
}

export function allocateDocumentPath(
  project: SourceProject,
  directory: string,
  resource: WritableDocument,
  pathCollisions?: SourcePathCollisionPolicy,
): string {
  const path = newSourceDocumentPath({
    directory,
    resource,
    occupied: project.tree.map((file) => file.path),
    pathCollisions,
  });
  if (path !== undefined) return path;
  return block(
    "source-path-collision",
    "A new Markdown path collides with the existing project.",
    resourceKey(resource),
    // The caller asked for no rename: name the path it would have had.
    pathCollisions === "refuse" ? sourceDocumentPathCandidates(directory, resource)[0] : undefined,
  );
}

export function authoredBody(
  resource: WritableDocument,
  path: string,
  assetsByName: ReadonlyMap<string, string>,
): string {
  if (resource.spec.content.format !== "topik")
    block(
      "content-unrepresentable",
      "Only unevaluated Topik content has a source representation.",
      resourceKey(resource),
    );
  const rewrite = rewriteTopikAssetOccurrences(
    resource.spec.content.value,
    (occurrence) => {
      if (!occurrence.reference.startsWith("asset:")) return undefined;
      const assetPath = assetsByName.get(occurrence.reference.slice(6));
      if (!assetPath)
        block(
          "asset-source-missing",
          "An Asset has no proven source path or supplied bytes.",
          resourceKey(resource),
        );
      return posix
        .relative(posix.dirname(path), assetPath)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
    },
    { allowCompiledAssetReferences: true, includeGenericLinkCandidates: true },
  );
  if (!rewrite.ok)
    block(
      "content-unrepresentable",
      "Asset references cannot be written faithfully.",
      resourceKey(resource),
    );
  const formatted = formatTopikContent(rewrite.content);
  if (!formatted.ok)
    block(
      "content-unrepresentable",
      "Content cannot be written faithfully.",
      resourceKey(resource),
    );
  return formatted.formatted;
}

export function writeMarkdown(
  base: SourceTreeFile | undefined,
  prior: WritableDocument | undefined,
  desired: WritableDocument,
  moved: boolean,
  path: string,
  assets: ReadonlyMap<string, string>,
  sourceContent?: string,
  referenceRepair = false,
): Uint8Array {
  const sections = base ? sourceMarkdownSections(base.bytes) : undefined;
  const oldContent = prior
    ? formatTopikContent(prior.spec.content.value, { allowCompiledAssetReferences: true })
    : undefined;
  const newContent = formatTopikContent(desired.spec.content.value, {
    allowCompiledAssetReferences: true,
  });
  if (!newContent.ok || (oldContent && !oldContent.ok))
    block(
      "content-unrepresentable",
      "Authoring content must remain writable.",
      resourceKey(desired),
    );
  const bodyChanged =
    !oldContent || oldContent.formatted !== newContent.formatted || moved || referenceRepair;
  const body = bodyChanged
    ? authoredBody(
        sourceContent === undefined
          ? desired
          : ({
              ...desired,
              spec: { ...desired.spec, content: { ...desired.spec.content, value: sourceContent } },
            } as WritableDocument),
        path,
        assets,
      )
    : sections!.body;
  const updates: Record<string, unknown> = {};
  if (
    !prior ||
    prior.spec.title !== desired.spec.title ||
    (bodyChanged &&
      !sections?.frontmatter?.match(/^title:/m) &&
      extractMarkdownTitle(body, desired.name) !== desired.spec.title)
  )
    updates.title = desired.spec.title;
  if (!prior || prior.spec.description !== desired.spec.description)
    updates.description = desired.spec.description;
  collectMetadataEdits(updates, "labels", prior?.labels, desired.labels);
  if (moved || !prior) updates.id = desired.name;
  if (desired.type === "Guide") {
    const old = prior?.type === "Guide" ? prior : undefined;
    if (moved || !old || old.spec.slug !== desired.spec.slug) updates.slug = desired.spec.slug;
    if (
      !old ||
      serializeTopikJson(old.spec.authors ?? null) !==
        serializeTopikJson(desired.spec.authors ?? null)
    )
      updates.authors = desired.spec.authors;
    if (
      !old ||
      serializeTopikJson(old.spec.tags ?? null) !== serializeTopikJson(desired.spec.tags ?? null)
    ) {
      updates.tags = desired.spec.tags;
      updates.inheritTags = false;
    }
  }
  if (desired.type === "CoursePage") {
    const old = prior?.type === "CoursePage" ? prior : undefined;
    if (moved || !old || old.spec.slug !== desired.spec.slug) updates.slug = desired.spec.slug;
    if (
      !old ||
      serializeTopikJson(old.spec.authors ?? null) !==
        serializeTopikJson(desired.spec.authors ?? null)
    )
      updates.authors = desired.spec.authors;
  }
  const eol = sections?.raw.includes("\r\n") ? "\r\n" : "\n";
  const writtenBody = bodyChanged && eol === "\r\n" ? body.replace(/(?<!\r)\n/g, eol) : body;
  if (!Object.keys(updates).length)
    return encodeSource(
      sections
        ? sections.raw.slice(0, sections.raw.length - sections.body.length) + writtenBody
        : writtenBody,
    );
  if (sections?.frontmatter !== undefined && sections.frontmatterRange) {
    const patched = patchFrontmatterFields(sections.frontmatter, updates, eol);
    // Nonempty frontmatter text excludes the line break before its closing fence.
    // An appended or removed final entry must not leave a blank line before it.
    let frontmatter = patched.bytes;
    const eolBytes = encodeSource(eol);
    if (
      sections.frontmatter &&
      !/[\r\n]$/.test(sections.frontmatter) &&
      Buffer.from(frontmatter.slice(-eolBytes.length)).equals(eolBytes)
    )
      frontmatter = frontmatter.slice(0, -eolBytes.length);
    return new Uint8Array(
      Buffer.concat([
        base!.bytes.slice(0, sections.frontmatterRange.start),
        frontmatter,
        base!.bytes.slice(sections.frontmatterRange.end, sections.bodyRange.start),
        encodeSource(writtenBody),
      ]),
    );
  }
  const metadata = Object.entries(updates)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}${eol}`)
    .join("");
  const prefix = sections ? sections.raw.slice(0, sections.raw.length - sections.body.length) : "";
  return encodeSource(
    prefix + (metadata ? `---${eol}${metadata}---${eol}${writtenBody}` : writtenBody),
  );
}
