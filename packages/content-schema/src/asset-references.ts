import type { TopikContentNode } from "./content";
import { formatTopikContent, parseTopikContent } from "./content";
import type { TopikAssetReferenceRole } from "./components";

export const TOPIK_ASSET_REFERENCE_VERSION = "topik-asset-reference-v1" as const;

export interface TopikAssetReferenceSlot {
  node: "image" | "tag" | "link";
  tag?: "figure";
  attribute: "src" | "darkSrc" | "href";
  slot: "image.src" | "figure.src" | "figure.darkSrc" | "link.href";
  role: TopikAssetReferenceRole;
  conditional?: "manifest-entry";
}

/**
 * Closed registry for topik-asset-reference-v1. Extractors never infer a slot from an
 * attribute name and never recursively inspect arbitrary strings.
 */
export const topikAssetReferenceSlots = [
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
    conditional: "manifest-entry",
  },
] as const satisfies readonly TopikAssetReferenceSlot[];

export type TopikAssetOccurrenceKind = "local" | "external-https" | "unsafe";

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
  reference: string;
  kind: TopikAssetOccurrenceKind;
  semantics: TopikAssetOccurrenceSemantics;
}

export interface ExtractTopikAssetOccurrencesOptions {
  /** Decoded manifest paths. Enables unambiguous generic download-link occurrences. */
  manifestPaths?: ReadonlySet<string> | readonly string[];
  /** Explicit schema/application declarations for downloadable generic-link positions. */
  downloadableLinkPositions?: ReadonlySet<string> | readonly string[];
}

export function extractTopikAssetOccurrences(
  source: string,
  options: ExtractTopikAssetOccurrencesOptions = {},
): TopikAssetOccurrence[] {
  const ast = parseTopikContent(source);
  const manifestPaths = toSet(options.manifestPaths);
  const downloadableLinkPositions = toSet(options.downloadableLinkPositions);
  const occurrences: TopikAssetOccurrence[] = [];

  walk(ast, [], (node, treePath) => {
    for (const definition of matchingSlots(node)) {
      const position = formatPosition(treePath, definition.attribute);
      const reference = stringAttribute(node, definition.attribute);
      if (reference == null) continue;
      if (
        definition.conditional === "manifest-entry" &&
        !downloadableLinkPositions.has(position) &&
        !manifestUnambiguouslyContains(reference, manifestPaths)
      ) {
        continue;
      }
      occurrences.push({
        position,
        treePath,
        slot: definition.slot,
        role: definition.role,
        reference,
        kind: classifyReference(reference),
        semantics: occurrenceSemantics(node, definition),
      });
    }
  });

  return occurrences;
}

export function rewriteTopikAssetOccurrences(
  source: string,
  replace: (occurrence: TopikAssetOccurrence) => string | undefined,
  options: ExtractTopikAssetOccurrencesOptions = {},
): string {
  const ast = parseTopikContent(source);
  const manifestPaths = toSet(options.manifestPaths);
  const downloadableLinkPositions = toSet(options.downloadableLinkPositions);

  walk(ast, [], (node, treePath) => {
    for (const definition of matchingSlots(node)) {
      const position = formatPosition(treePath, definition.attribute);
      const reference = stringAttribute(node, definition.attribute);
      if (reference == null) continue;
      if (
        definition.conditional === "manifest-entry" &&
        !downloadableLinkPositions.has(position) &&
        !manifestUnambiguouslyContains(reference, manifestPaths)
      ) {
        continue;
      }
      const occurrence: TopikAssetOccurrence = {
        position,
        treePath,
        slot: definition.slot,
        role: definition.role,
        reference,
        kind: classifyReference(reference),
        semantics: occurrenceSemantics(node, definition),
      };
      const replacement = replace(occurrence);
      if (replacement !== undefined) node.attributes[definition.attribute] = replacement;
    }
  });

  return formatTopikContent(ast);
}

function matchingSlots(node: TopikContentNode): readonly TopikAssetReferenceSlot[] {
  const tag = (node as TopikContentNode & { tag?: string }).tag;
  return (topikAssetReferenceSlots as readonly TopikAssetReferenceSlot[]).filter(
    (definition) =>
      definition.node === node.type && (definition.tag == null || definition.tag === tag),
  );
}

function walk(
  node: TopikContentNode,
  treePath: readonly number[],
  visit: (node: TopikContentNode, treePath: readonly number[]) => void,
): void {
  visit(node, treePath);
  for (let index = 0; index < node.children.length; index++) {
    walk(node.children[index], [...treePath, index], visit);
  }
}

function formatPosition(treePath: readonly number[], attribute: string): string {
  const nodePosition = treePath.map((index) => `/children/${index}`).join("");
  return `${nodePosition}/attributes/${attribute}`;
}

function stringAttribute(node: TopikContentNode, attribute: string): string | undefined {
  const value = node.attributes?.[attribute];
  return typeof value === "string" ? value : undefined;
}

function occurrenceSemantics(
  node: TopikContentNode,
  definition: TopikAssetReferenceSlot,
): TopikAssetOccurrenceSemantics {
  const alt = stringAttribute(node, "alt");
  const title = stringAttribute(node, "title");
  const caption = stringAttribute(node, "caption");
  return {
    ...(alt !== undefined ? { alt, decorative: alt.length === 0 } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(caption !== undefined ? { caption } : {}),
    ...(definition.role === "image-light" ? { lightDarkRole: "light" as const } : {}),
    ...(definition.role === "image-dark" ? { lightDarkRole: "dark" as const } : {}),
    ...(definition.role === "download" ? { linkLabel: plainText(node) } : {}),
  };
}

function plainText(node: TopikContentNode): string {
  if (node.type === "text") {
    const content = node.attributes?.content;
    return typeof content === "string" ? content : "";
  }
  return node.children.map(plainText).join("");
}

function classifyReference(reference: string): TopikAssetOccurrenceKind {
  if (containsControl(reference) || reference.includes("\\")) return "unsafe";
  if (reference.startsWith("https://")) {
    try {
      const url = new URL(reference);
      return url.protocol === "https:" && url.username === "" && url.password === ""
        ? "external-https"
        : "unsafe";
    } catch {
      return "unsafe";
    }
  }
  if (reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) return "unsafe";
  return "local";
}

function manifestUnambiguouslyContains(reference: string, paths: ReadonlySet<string>): boolean {
  if (paths.size === 0 || reference.includes("?") || reference.includes("#")) return false;
  try {
    return paths.has(decodeURIComponent(reference));
  } catch {
    return false;
  }
}

function toSet(values?: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (values == null) return new Set<string>();
  return new Set(values);
}

function isControl(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function containsControl(value: string): boolean {
  for (const character of value) if (isControl(character)) return true;
  return false;
}
