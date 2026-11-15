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

export function allocateDocumentPath(
  project: SourceProject,
  directory: string,
  resource: WritableDocument,
): string {
  const slug =
    resource.type === "Guide" || resource.type === "CoursePage"
      ? resource.spec.slug
      : resource.name;
  const stem = posix.join(directory, slug || "index");
  for (const suffix of ["", `-${sourceHash(encodeSource(resource.name)).slice(0, 8)}`]) {
    const candidate = `${stem}${suffix}.md`;
    if (
      !project.tree.some((file) => file.path === candidate) &&
      validateTopikPathSet([...project.tree.map((file) => file.path), candidate]).ok
    )
      return candidate;
  }
  return block(
    "source-path-collision",
    "A new Markdown path collides with the existing project.",
    resourceKey(resource),
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
  version: unknown,
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
  if (desired.type !== "CoursePage") {
    const priorDescription =
      prior && prior.type !== "CoursePage" ? prior.spec.description : undefined;
    if (!prior || priorDescription !== desired.spec.description)
      updates.description = desired.spec.description;
  }
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
    if (!old || old.spec.order !== desired.spec.order) updates.order = desired.spec.order;
    if (
      !old ||
      serializeTopikJson(old.spec.authors ?? null) !==
        serializeTopikJson(desired.spec.authors ?? null)
    )
      updates.authors = desired.spec.authors;
  }
  if (
    version !== 1 &&
    Object.keys(updates).some((field) =>
      ["id", "slug", "labels", "inheritTags"].includes(field.split("/")[0]),
    )
  )
    block(
      "source-version-required",
      "This change needs an explicitly reviewed sourceVersion: 1 opt-in.",
      resourceKey(desired),
    );
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
