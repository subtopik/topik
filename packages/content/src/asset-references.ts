import type { TopikContentCache } from "./parse-cache.js";
import type { Node } from "mdast";
import type { ContentDocument, TextTemplate, TreeNode } from "./model.js";
import type { TopikAssetReferenceRole } from "./registry.js";
import type { TopikContentConfig } from "./config.js";
import { parseTopikContent } from "./content.js";
import { plainText } from "./traversal.js";
import { indexDocument, isReference, type DocumentIndex } from "./document-index.js";
import { createReferenceSourceLookup } from "./reference-source.js";
import { validateTopikAssetReference } from "./asset-reference-policy.js";
export * from "./asset-reference-policy.js";

export interface TopikAssetReferenceSlot {
  node: "image" | "tag" | "link";
  tag?: "figure" | "video";
  attribute: "src" | "darkSrc" | "poster" | "href";
  slot: "image.src" | "figure.src" | "figure.darkSrc" | "video.src" | "video.poster" | "link.href";
  role: TopikAssetReferenceRole;
  conditional?: "proven-download";
}

/**
 * Closed registry for topik-asset-reference-v1. Extractors never infer a slot from an
 * attribute name and never recursively inspect arbitrary strings.
 */
const topikAssetReferenceSlots = Object.freeze([
  { node: "image", attribute: "src", slot: "image.src", role: "image" },
  {
    node: "tag",
    tag: "figure",
    attribute: "src",
    slot: "figure.src",
    role: "image-light",
  },
  {
    node: "tag",
    tag: "figure",
    attribute: "darkSrc",
    slot: "figure.darkSrc",
    role: "image-dark",
  },
  { node: "tag", tag: "video", attribute: "src", slot: "video.src", role: "video" },
  { node: "tag", tag: "video", attribute: "poster", slot: "video.poster", role: "image" },
  {
    node: "link",
    attribute: "href",
    slot: "link.href",
    role: "download",
    conditional: "proven-download",
  },
] as const satisfies readonly TopikAssetReferenceSlot[]);
for (const slot of topikAssetReferenceSlots) Object.freeze(slot);

export type TopikAssetOccurrenceKind =
  | "asset"
  | "reserved-asset"
  | "local"
  | "external-https"
  | "unsafe";

export interface TopikAssetOccurrenceSemantics {
  alt?: string;
  /** Authored text, detached from source nodes and never resolved by asset operations. */
  altTemplate?: TextTemplate;
  decorative?: boolean;
  title?: string;
  /** Authored video title, detached from source nodes and never resolved by asset operations. */
  titleTemplate?: TextTemplate;
  caption?: string;
  captionTemplate?: TextTemplate;
  lightDarkRole?: "light" | "dark";
  linkLabel?: string;
}

export interface TopikAssetOccurrence {
  /** Stable normalized tree position, independent from other occurrences. */
  position: string;
  treePath: readonly number[];
  slot: TopikAssetReferenceSlot["slot"];
  role: TopikAssetReferenceRole;
  /** Parser-produced destination used only to prove what the exact source bytes resolve to. */
  parsedReference: string;
  reference: string;
  kind: TopikAssetOccurrenceKind;
  semantics: TopikAssetOccurrenceSemantics;
}

export interface ExtractTopikAssetOccurrencesOptions {
  config?: TopikContentConfig;
  /** Decoded regular-file paths. Enables unambiguous generic download-link occurrences. */
  provenDownloadPaths?: ReadonlySet<string> | readonly string[];
  /** Return generic-link candidates so a compiler can prove plain-mode downloads. */
  includeGenericLinkCandidates?: boolean;
  /** @internal Parse results shared with other calls given the same cache. */
  cache?: TopikContentCache;
}

type ResourceNode = TreeNode & {
  url?: string;
  identifier?: string;
  alt?: string;
  title?: string | null;
};

interface LocatedOccurrence {
  occurrence: TopikAssetOccurrence;
  node: ResourceNode;
  replace: (value: string) => void;
}

/** @internal Ordinary navigation shares URL policy, but is not an asset location. */
export function requiresAssetValidation(occurrence: TopikAssetOccurrence): boolean {
  return (
    occurrence.slot !== "link.href" ||
    occurrence.kind === "asset" ||
    occurrence.kind === "reserved-asset" ||
    /^https?:/iu.test(occurrence.parsedReference)
  );
}

function reservedScheme(value: string): boolean {
  // Recognize encoded scheme spelling as reserved without admitting it as canonical.
  const decoded = value.replace(/%([0-9a-f]{2})/giu, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return /^asset:/iu.test(decoded);
}

function classify(reference: string, parsed: string): TopikAssetOccurrenceKind {
  if (reservedScheme(reference) || reservedScheme(parsed)) {
    const result = validateTopikAssetReference(reference);
    return reference === parsed && result.valid && result.kind === "asset"
      ? "asset"
      : "reserved-asset";
  }
  return reference === parsed ? validateTopikAssetReference(reference).kind : "unsafe";
}

/** @internal Keep the source node available for diagnostics without extending the occurrence protocol. */
export function locateDocumentAssetOccurrences(
  document: ContentDocument,
  source: string | undefined,
  options: ExtractTopikAssetOccurrencesOptions,
  index: DocumentIndex = indexDocument(document),
): LocatedOccurrence[] {
  const proven = new Set(options.provenDownloadPaths ?? []);
  const referenceFromSource =
    source === undefined
      ? undefined
      : createReferenceSourceLookup(source, () =>
          indexDocument(
            parseTopikContent(source, { config: options.config, cache: options.cache }),
          ),
        );
  const result: LocatedOccurrence[] = [];
  for (const { node: untyped, path } of index.entries) {
    const node = untyped as ResourceNode;
    const referenceForm = node.type === "imageReference" || node.type === "linkReference";
    const definition = isReference(node) ? index.resolve(node) : undefined;
    const image = node.type === "image" || node.type === "imageReference";
    const link = node.type === "link" || node.type === "linkReference";
    // Component slots read authored attributes; Markdown images and links read destinations.
    const tag =
      node.type === "topikComponent" && (node.name === "figure" || node.name === "video")
        ? node.name
        : undefined;
    if (!image && !link && !tag) continue;

    for (const slot of topikAssetReferenceSlots) {
      if (slot.node === "image" ? !image : slot.node === "link" ? !link : slot.tag !== tag)
        continue;
      const resource = definition ?? node;
      const parsedReference = tag ? node.props?.[slot.attribute] : resource.url;
      if (typeof parsedReference !== "string") continue;
      const reference =
        tag || referenceFromSource === undefined
          ? parsedReference
          : referenceFromSource(resource as Node & { url: string });
      const kind = classify(reference, parsedReference);
      if (
        link &&
        !options.includeGenericLinkCandidates &&
        kind !== "asset" &&
        kind !== "reserved-asset"
      ) {
        const validation = validateTopikAssetReference(reference);
        if (!validation.valid || validation.kind !== "local" || !proven.has(validation.decodedPath))
          continue;
      }
      const alt = tag === "figure" ? node.props?.alt : tag ? undefined : node.alt;
      const title = tag === "video" ? node.props?.title : tag ? undefined : resource.title;
      const caption = tag ? node.props?.caption : undefined;
      const occurrence: TopikAssetOccurrence = {
        position: `${path.map((index) => `/children/${index}`).join("")}/attributes/${slot.attribute}`,
        treePath: path,
        slot: slot.slot,
        role: slot.role,
        parsedReference,
        reference,
        kind,
        semantics: {
          ...(typeof alt === "string" ? { alt, decorative: alt.length === 0 } : {}),
          ...(alt && typeof alt === "object" ? { altTemplate: structuredClone(alt) } : {}),
          ...(typeof title === "string" ? { title } : {}),
          ...(title && typeof title === "object" ? { titleTemplate: structuredClone(title) } : {}),
          ...(typeof caption === "string" ? { caption } : {}),
          ...(caption && typeof caption === "object"
            ? { captionTemplate: structuredClone(caption) }
            : {}),
          ...(slot.slot === "figure.src" ? { lightDarkRole: "light" as const } : {}),
          ...(slot.slot === "figure.darkSrc" ? { lightDarkRole: "dark" as const } : {}),
          ...(link ? { linkLabel: plainText(node) } : {}),
        },
      };
      result.push({
        occurrence,
        node,
        replace(value) {
          if (tag) {
            node.props![slot.attribute] = value;
            return;
          }
          if (referenceForm) {
            // References share a definition; materialize this occurrence so one
            // replacement cannot silently retarget another image or navigation link.
            node.type = image ? "image" : "link";
            node.title = definition?.title ?? null;
            delete node.identifier;
            delete (node as ResourceNode & { referenceType?: string }).referenceType;
            delete (node as ResourceNode & { label?: string }).label;
          }
          node.url = value;
        },
      });
    }
  }
  return result;
}

export function extractTopikAssetOccurrences(
  source: string,
  options: ExtractTopikAssetOccurrencesOptions = {},
): TopikAssetOccurrence[] {
  const document = parseTopikContent(source, { config: options.config, cache: options.cache });
  return extractDocumentAssetOccurrences(document, source, options);
}

/** @internal Reuse the parsed document during source admission. */
export function extractDocumentAssetOccurrences(
  document: ContentDocument,
  source: string,
  options: ExtractTopikAssetOccurrencesOptions = {},
  index?: DocumentIndex,
): TopikAssetOccurrence[] {
  return locateDocumentAssetOccurrences(document, source, options, index).map(
    ({ occurrence }) => occurrence,
  );
}

/** @internal Validation must complete before user replacement callbacks run. */
export function rewriteDocumentAssetOccurrences(
  document: ContentDocument,
  source: string,
  replace: (occurrence: TopikAssetOccurrence) => string | undefined,
  options: ExtractTopikAssetOccurrencesOptions = {},
  index?: DocumentIndex,
): void {
  for (const located of locateDocumentAssetOccurrences(document, source, options, index)) {
    const value = replace(located.occurrence);
    if (value !== undefined) located.replace(value);
  }
}
