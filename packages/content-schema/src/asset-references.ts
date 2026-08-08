import Markdoc from "@markdoc/markdoc";
import { decodeHTMLStrict } from "entities";
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
  /** Parser-produced destination used only to prove what the exact source bytes resolve to. */
  parsedReference: string;
  reference: string;
  kind: TopikAssetOccurrenceKind;
  semantics: TopikAssetOccurrenceSemantics;
}

export interface ExtractTopikAssetOccurrencesOptions {
  /** Decoded manifest paths. Enables unambiguous generic download-link occurrences. */
  manifestPaths?: ReadonlySet<string> | readonly string[];
  /** Explicit schema/application declarations for downloadable generic-link positions. */
  downloadableLinkPositions?: ReadonlySet<string> | readonly string[];
  /** Return generic-link candidates so a compiler can prove plain-mode downloads. */
  includeGenericLinkCandidates?: boolean;
}

export type TopikAssetReferenceValidation =
  | { valid: true; kind: "local"; decodedPath: string }
  | { valid: true; kind: "external-https" }
  | { valid: false; kind: "unsafe"; failureKind: "local" | "external" };

export function extractTopikAssetOccurrences(
  source: string,
  options: ExtractTopikAssetOccurrencesOptions = {},
): TopikAssetOccurrence[] {
  const ast = parseTopikContent(source);
  const manifestPaths = toSet(options.manifestPaths);
  const downloadableLinkPositions = toSet(options.downloadableLinkPositions);
  const occurrences: TopikAssetOccurrence[] = [];
  const exactReferences = exactMarkdownReferences(source);

  walk(ast, [], (node, treePath) => {
    for (const definition of matchingSlots(node)) {
      const position = formatPosition(treePath, definition.attribute);
      const parsedReference = stringAttribute(node, definition.attribute);
      if (parsedReference == null) continue;
      const reference =
        definition.node === "image"
          ? (exactReferences.images.shift() ?? parsedReference)
          : definition.node === "link"
            ? (exactReferences.links.shift() ?? parsedReference)
            : parsedReference;
      if (
        definition.conditional === "manifest-entry" &&
        options.includeGenericLinkCandidates !== true &&
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
        parsedReference,
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
  const exactReferences = exactMarkdownReferences(source);

  walk(ast, [], (node, treePath) => {
    for (const definition of matchingSlots(node)) {
      const position = formatPosition(treePath, definition.attribute);
      const parsedReference = stringAttribute(node, definition.attribute);
      if (parsedReference == null) continue;
      const reference =
        definition.node === "image"
          ? (exactReferences.images.shift() ?? parsedReference)
          : definition.node === "link"
            ? (exactReferences.links.shift() ?? parsedReference)
            : parsedReference;
      if (
        definition.conditional === "manifest-entry" &&
        options.includeGenericLinkCandidates !== true &&
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
        parsedReference,
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
  return validateTopikAssetReference(reference).kind;
}

function manifestUnambiguouslyContains(reference: string, paths: ReadonlySet<string>): boolean {
  if (paths.size === 0) return false;
  const validation = validateTopikAssetReference(reference);
  return validation.valid && validation.kind === "local" && paths.has(validation.decodedPath);
}

function toSet(values?: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (values == null) return new Set<string>();
  return new Set(values);
}

/** Validate the URL-facing portion of topik-asset-reference-v1 without filesystem access. */
export function validateTopikAssetReference(reference: string): TopikAssetReferenceValidation {
  if (containsUnsafeUnicode(reference) || reference.includes("\\")) {
    return unsafe(reference);
  }
  if (reference.startsWith("https://")) {
    try {
      const url = new URL(reference);
      return url.protocol === "https:" && url.username === "" && url.password === ""
        ? { valid: true, kind: "external-https" }
        : { valid: false, kind: "unsafe", failureKind: "external" };
    } catch {
      return { valid: false, kind: "unsafe", failureKind: "external" };
    }
  }
  if (reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    return { valid: false, kind: "unsafe", failureKind: "external" };
  }
  if (
    reference.length === 0 ||
    reference.startsWith("/") ||
    reference.includes("?") ||
    reference.includes("#") ||
    containsNonAscii(reference)
  ) {
    return { valid: false, kind: "unsafe", failureKind: "local" };
  }

  const bytes: number[] = [];
  for (let index = 0; index < reference.length; index++) {
    const character = reference[index];
    if (character === "/") {
      bytes.push(0x2f);
      continue;
    }
    if (character === "%") {
      const pair = reference.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/u.test(pair)) {
        return { valid: false, kind: "unsafe", failureKind: "local" };
      }
      const byte = Number.parseInt(pair, 16);
      if (byte === 0x2f || byte === 0x5c || byte === 0x25) {
        return { valid: false, kind: "unsafe", failureKind: "local" };
      }
      bytes.push(byte);
      index += 2;
      continue;
    }
    if (!/^[A-Za-z0-9._~-]$/u.test(character)) {
      return { valid: false, kind: "unsafe", failureKind: "local" };
    }
    bytes.push(character.charCodeAt(0));
  }

  let decodedPath: string;
  try {
    decodedPath = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return { valid: false, kind: "unsafe", failureKind: "local" };
  }
  if (!isSafeDecodedPath(decodedPath) || encodeLocalPath(decodedPath) !== reference) {
    return { valid: false, kind: "unsafe", failureKind: "local" };
  }
  return { valid: true, kind: "local", decodedPath };
}

/** Remove invalid unconditional asset attributes before renderer transformation. */
export function removeInvalidTopikAssetReferences(root: TopikContentNode, source?: string): void {
  const invalidSourcePositions =
    source === undefined
      ? undefined
      : new Set(
          extractTopikAssetOccurrences(source)
            .filter((occurrence) => !validateTopikAssetReference(occurrence.reference).valid)
            .map((occurrence) => occurrence.position),
        );
  walk(root, [], (node, treePath) => {
    for (const definition of matchingSlots(node)) {
      if (definition.conditional === "manifest-entry") continue;
      const reference = stringAttribute(node, definition.attribute);
      const sourceWasInvalid = invalidSourcePositions?.has(
        formatPosition(treePath, definition.attribute),
      );
      if (
        reference !== undefined &&
        (sourceWasInvalid === true || !validateTopikAssetReference(reference).valid)
      ) {
        delete node.attributes[definition.attribute];
      }
    }
  });
}

function unsafe(reference: string): TopikAssetReferenceValidation {
  return {
    valid: false,
    kind: "unsafe",
    failureKind:
      reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference) ? "external" : "local",
  };
}

function isSafeDecodedPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    path.normalize("NFC") !== path ||
    containsUnsafeUnicode(path) ||
    /[<>:"|?*]/u.test(path)
  ) {
    return false;
  }
  const components = path.split("/");
  return components.every(
    (component) =>
      component.length > 0 && component !== "." && component !== ".." && !/[. ]$/u.test(component),
  );
}

function encodeLocalPath(path: string): string {
  const encoder = new TextEncoder();
  return path
    .split("/")
    .map((component) =>
      [...encoder.encode(component)]
        .map((byte) => {
          const character = String.fromCharCode(byte);
          return /^[A-Za-z0-9._~-]$/u.test(character)
            ? character
            : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        })
        .join(""),
    )
    .join("/");
}

function containsUnsafeUnicode(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Noncharacter_Code_Point}]/u.test(
    value,
  );
}

function containsNonAscii(value: string): boolean {
  for (const character of value) if ((character.codePointAt(0) ?? 0) > 0x7f) return true;
  return false;
}

interface MarkdownDestination {
  kind: "image" | "link";
  reference: string;
}

function exactMarkdownReferences(source: string): { images: string[]; links: string[] } {
  const images: string[] = [];
  const links: string[] = [];
  const definitions = parseMarkdownReferenceDefinitions(source);
  const tokens = new Markdoc.Tokenizer().tokenize(source) as Array<{
    type?: string;
    content?: string;
    children?: Array<{ type?: string; attrs?: Array<[string, string]> | null }> | null;
  }>;
  for (const token of tokens) {
    if (token.type !== "inline" || token.children == null) continue;
    const scanned = scanMarkdownDestinations(token.content ?? "", definitions);
    let scanIndex = 0;
    for (const child of token.children) {
      const kind =
        child.type === "image" ? "image" : child.type === "link_open" ? "link" : undefined;
      if (kind === undefined) continue;
      const attribute = kind === "image" ? "src" : "href";
      const parsed = child.attrs?.find(([name]) => name === attribute)?.[1];
      if (parsed === undefined) continue;
      let exact = parsed;
      for (let index = scanIndex; index < scanned.length; index++) {
        const candidate = scanned[index];
        if (candidate.kind !== kind || !sameMarkdownDestination(candidate.reference, parsed)) {
          continue;
        }
        exact = candidate.reference;
        scanIndex = index + 1;
        break;
      }
      (kind === "image" ? images : links).push(exact);
    }
  }
  return { images, links };
}

function scanMarkdownDestinations(
  source: string,
  definitions: ReadonlyMap<string, string>,
): MarkdownDestination[] {
  const destinations: MarkdownDestination[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "`" && !isEscaped(source, index)) {
      const width = countRun(source, index, "`");
      const closing = source.indexOf("`".repeat(width), index + width);
      if (closing !== -1) index = closing + width - 1;
      continue;
    }
    const image = source[index] === "!" && source[index + 1] === "[";
    if (!image && source[index] !== "[") continue;
    const opening = image ? index + 1 : index;
    if (isEscaped(source, opening)) continue;
    const labelEnd = findBalancedMarkdownLabelEnd(source, opening);
    if (labelEnd === -1) continue;
    const kind = image ? "image" : "link";
    const label = source.slice(opening + 1, labelEnd);
    let reference: string | undefined;
    let end = labelEnd;
    if (source[labelEnd + 1] === "(") {
      const inline = scanInlineMarkdownDestination(source, labelEnd + 2);
      if (inline === undefined) continue;
      reference = inline.reference;
      end = inline.end;
    } else if (source[labelEnd + 1] === "[") {
      const referenceLabelEnd = findUnescaped(source, "]", labelEnd + 2);
      if (referenceLabelEnd === -1) continue;
      const explicitLabel = source.slice(labelEnd + 2, referenceLabelEnd);
      reference = definitions.get(normalizeMarkdownReference(explicitLabel || label));
      end = referenceLabelEnd;
    } else {
      reference = definitions.get(normalizeMarkdownReference(label));
    }
    if (reference !== undefined && reference.length > 0) {
      destinations.push({ kind, reference });
      if (kind === "link") {
        destinations.push(
          ...scanMarkdownDestinations(label, definitions).filter(
            (destination) => destination.kind === "image",
          ),
        );
      }
      index = end;
    }
  }
  return destinations;
}

function scanInlineMarkdownDestination(
  source: string,
  start: number,
): { reference: string; end: number } | undefined {
  let cursor = start;
  while (source[cursor] === " " || source[cursor] === "\t") cursor++;
  let reference: string;
  if (source[cursor] === "<") {
    const destinationEnd = findUnescaped(source, ">", cursor + 1);
    if (destinationEnd === -1) return undefined;
    reference = source.slice(cursor + 1, destinationEnd);
    cursor = destinationEnd + 1;
  } else {
    const destinationStart = cursor;
    let depth = 0;
    for (; cursor < source.length; cursor++) {
      const character = source[cursor];
      if (character === "(" && !isEscaped(source, cursor)) depth++;
      if (character === ")" && !isEscaped(source, cursor)) {
        if (depth === 0) break;
        depth--;
      }
      if ((character === " " || character === "\t" || character === "\n") && depth === 0) {
        break;
      }
    }
    reference = source.slice(destinationStart, cursor);
  }
  const closing = findUnescaped(source, ")", cursor);
  return reference.length === 0 || closing === -1 ? undefined : { reference, end: closing };
}

function parseMarkdownReferenceDefinitions(source: string): ReadonlyMap<string, string> {
  const definitions = new Map<string, string>();
  const lines = source.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    let line = lines[lineIndex];
    let cursor = 0;
    while (cursor < 4 && line[cursor] === " ") cursor++;
    if (cursor > 3 || line[cursor] !== "[") continue;
    const labelEnd = findUnescaped(line, "]", cursor + 1);
    if (labelEnd === -1 || line[labelEnd + 1] !== ":") continue;
    const label = normalizeMarkdownReference(line.slice(cursor + 1, labelEnd));
    if (label.length === 0 || definitions.has(label)) continue;
    cursor = labelEnd + 2;
    while (line[cursor] === " " || line[cursor] === "\t") cursor++;
    if (cursor === line.length) {
      const continuation = lines[lineIndex + 1];
      if (continuation === undefined || continuation.trim().length === 0) continue;
      line = continuation;
      cursor = 0;
      while (line[cursor] === " " || line[cursor] === "\t") cursor++;
      if (looksLikeMarkdownReferenceDefinition(line, cursor)) continue;
    }
    let reference: string;
    if (line[cursor] === "<") {
      const destinationEnd = findUnescaped(line, ">", cursor + 1);
      if (destinationEnd === -1) continue;
      reference = line.slice(cursor + 1, destinationEnd);
    } else {
      const destinationStart = cursor;
      let depth = 0;
      for (; cursor < line.length; cursor++) {
        const character = line[cursor];
        if (character === "(" && !isEscaped(line, cursor)) depth++;
        if (character === ")" && !isEscaped(line, cursor)) {
          if (depth === 0) break;
          depth--;
        }
        if ((character === " " || character === "\t") && depth === 0) break;
      }
      reference = line.slice(destinationStart, cursor);
    }
    if (reference.length > 0) definitions.set(label, reference);
  }
  return definitions;
}

function looksLikeMarkdownReferenceDefinition(line: string, start: number): boolean {
  if (line[start] !== "[") return false;
  const labelEnd = findUnescaped(line, "]", start + 1);
  return labelEnd !== -1 && line[labelEnd + 1] === ":";
}

function normalizeMarkdownReference(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.replace(/ẞ/gu, "ß").toLowerCase().toUpperCase();
}

function sameMarkdownDestination(raw: string, parsed: string): boolean {
  if (raw === parsed) return true;
  try {
    const unescaped = unescapeMarkdownDestination(raw);
    return unescaped === parsed || encodeURI(unescaped) === parsed;
  } catch {
    return false;
  }
}

const MARKDOWN_DESTINATION_ESCAPE_OR_ENTITY =
  /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|&([a-z#][a-z0-9]{1,31});/giu;

function unescapeMarkdownDestination(value: string): string {
  return value.replace(
    MARKDOWN_DESTINATION_ESCAPE_OR_ENTITY,
    (match, escaped: string | undefined, entity: string | undefined) =>
      escaped ?? (entity === undefined ? match : decodeHTMLStrict(`&${entity};`)),
  );
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function findUnescaped(value: string, character: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    if (value[index] === character && !isEscaped(value, index)) return index;
  }
  return -1;
}

function findBalancedMarkdownLabelEnd(value: string, opening: number): number {
  let depth = 1;
  for (let index = opening + 1; index < value.length; index++) {
    if (isEscaped(value, index)) continue;
    if (value[index] === "[") {
      depth++;
    } else if (value[index] === "]") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function countRun(value: string, start: number, character: string): number {
  let count = 0;
  while (value[start + count] === character) count++;
  return count;
}
