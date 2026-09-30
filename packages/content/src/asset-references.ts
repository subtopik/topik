import type { Node } from "mdast";
import type { ContentDocument, TreeNode } from "./model.js";
import type { TopikAssetReferenceRole } from "./registry.js";
import type { TopikContentConfig } from "./config.js";
import { parseTopikContent } from "./content.js";
import { plainText } from "./traversal.js";
import { indexDocument, isReference, type DocumentIndex } from "./document-index.js";
import { createReferenceSourceLookup } from "./reference-source.js";
import { validateTopikAssetReference } from "./asset-reference-policy.js";
import { validateTopikHref } from "./links.js";
import { inlineParentTypes } from "./node-grammar.js";
export * from "./asset-reference-policy.js";

export interface TopikAssetReferenceSlot {
  node: "image" | "tag" | "link";
  tag?: "figure";
  attribute: "src" | "darkSrc" | "href";
  slot: "image.src" | "figure.src" | "figure.darkSrc" | "link.href";
  role: TopikAssetReferenceRole;
  conditional?: "proven-download";
}

/**
 * Closed registry for topik-asset-reference-v1. Extractors never infer a slot from an
 * attribute name and never recursively inspect arbitrary strings.
 */
export const topikAssetReferenceSlots = Object.freeze([
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
  decorative?: boolean;
  title?: string;
  caption?: string;
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
          indexDocument(parseTopikContent(source, { config: options.config })),
        );
  const result: LocatedOccurrence[] = [];
  for (const { node: untyped, path } of index.entries) {
    const node = untyped as ResourceNode;
    const referenceForm = node.type === "imageReference" || node.type === "linkReference";
    const definition = isReference(node) ? index.resolve(node) : undefined;
    const image = node.type === "image" || node.type === "imageReference";
    const link = node.type === "link" || node.type === "linkReference";
    const figure = node.type === "topikComponent" && node.name === "figure";
    if (!image && !link && !figure) continue;

    for (const slot of topikAssetReferenceSlots) {
      if (slot.node === "image" ? !image : slot.node === "link" ? !link : !figure) continue;
      const resource = definition ?? node;
      const parsedReference = figure ? node.props?.[slot.attribute] : resource.url;
      if (typeof parsedReference !== "string") continue;
      const reference =
        figure || referenceFromSource === undefined
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
      const alt = figure ? node.props?.alt : node.alt;
      const title = resource.title;
      const caption = figure ? node.props?.caption : undefined;
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
          ...(typeof title === "string" ? { title } : {}),
          ...(typeof caption === "string" ? { caption } : {}),
          ...(slot.slot === "figure.src" ? { lightDarkRole: "light" as const } : {}),
          ...(slot.slot === "figure.darkSrc" ? { lightDarkRole: "dark" as const } : {}),
          ...(link ? { linkLabel: plainText(node) } : {}),
        },
      };
      result.push({
        occurrence,
        node,
        replace(value) {
          if (figure) {
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
  const document = parseTopikContent(source, { config: options.config });
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

/** Remove unsafe destinations from a preview tree, retaining readable descriptions. */
export function removeInvalidTopikAssetReferences(
  document: ContentDocument,
  source?: string,
  options: { config?: TopikContentConfig } = {},
): void {
  const removed = new Set<TreeNode>();
  for (const { occurrence, node } of locateDocumentAssetOccurrences(document, source, {
    ...options,
    includeGenericLinkCandidates: true,
  })) {
    const invalid =
      (occurrence.slot === "link.href" &&
        validateTopikHref(occurrence.parsedReference).length > 0) ||
      (requiresAssetValidation(occurrence) &&
        (occurrence.kind === "unsafe" || occurrence.kind === "reserved-asset"));
    if (!invalid) continue;
    if (occurrence.slot === "figure.darkSrc") delete node.props!.darkSrc;
    else removed.add(node);
  }
  if (removed.size === 0) return;

  function sanitize(node: TreeNode, inline = false): TreeNode[] {
    const hadChildren = Boolean(node.children?.length);
    if (node.children) {
      const inlineChildren =
        inlineParentTypes.has(node.type) || (node.type === "topikComponent" && inline);
      node.children = node.children.flatMap((child) => sanitize(child, inlineChildren));
      if (inlineParentTypes.has(node.type) && node.type !== "link" && node.type !== "linkReference")
        while (node.children.at(-1)?.type === "break") node.children.pop();
    }
    if (removed.has(node)) {
      if (node.type === "link" || node.type === "linkReference") return node.children ?? [];
      const figure = node.type === "topikComponent";
      const value = figure
        ? [node.props?.alt, node.props?.caption]
            .filter((part) => typeof part === "string" && part)
            .join("\n")
        : ((node as ResourceNode).alt ?? "");
      if (!value) return [];
      const text: TreeNode = { type: "text", value, position: node.position };
      return figure ? [{ type: "paragraph", children: [text], position: node.position }] : [text];
    }
    // Removing decorative images can empty a paragraph, mark, or paired inline
    // component. Keep block containers and self-closing inline components intact.
    if (
      hadChildren &&
      node.children?.length === 0 &&
      (["paragraph", "emphasis", "strong", "delete"].includes(node.type) ||
        (node.type === "topikComponent" && inline))
    )
      return [];
    return [node];
  }
  sanitize(document as TreeNode);
}
