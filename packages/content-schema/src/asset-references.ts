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
  conditional?: "proven-download";
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
    conditional: "proven-download",
  },
] as const satisfies readonly TopikAssetReferenceSlot[];

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
  /** Decoded regular-file paths. Enables unambiguous generic download-link occurrences. */
  provenDownloadPaths?: ReadonlySet<string> | readonly string[];
  /** Return generic-link candidates so a compiler can prove plain-mode downloads. */
  includeGenericLinkCandidates?: boolean;
}

export type TopikAssetReferenceValidation =
  | { valid: true; kind: "asset"; name: string }
  | { valid: true; kind: "local"; decodedPath: string }
  | { valid: true; kind: "external-https" }
  | { valid: false; kind: "unsafe"; failureKind: "local" | "external" };

export function extractTopikAssetOccurrences(
  source: string,
  options: ExtractTopikAssetOccurrencesOptions = {},
): TopikAssetOccurrence[] {
  const ast = parseTopikContent(source);
  const provenDownloadPaths = toSet(options.provenDownloadPaths);
  const occurrences: TopikAssetOccurrence[] = [];
  const exactReferences = exactMarkdownReferences(source);

  walk(ast, [], (node, treePath) => {
    for (const definition of matchingSlots(node)) {
      const position = formatPosition(treePath, definition.attribute);
      const parsedReference = stringAttribute(node, definition.attribute);
      if (parsedReference == null) continue;
      const reference =
        definition.node === "image"
          ? (takeExactMarkdownReference(exactReferences, node, "image") ?? "")
          : definition.node === "link"
            ? (takeExactMarkdownReference(exactReferences, node, "link") ?? "")
            : parsedReference;
      if (
        definition.conditional === "proven-download" &&
        options.includeGenericLinkCandidates !== true &&
        !provenDownloadsUnambiguouslyContain(reference, provenDownloadPaths) &&
        !isCanonicalAssetReference(reference) &&
        !usesReservedAssetScheme(reference, parsedReference)
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
        kind: classifyExactReference(reference, parsedReference),
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
  const provenDownloadPaths = toSet(options.provenDownloadPaths);
  const exactReferences = exactMarkdownReferences(source);

  walk(ast, [], (node, treePath) => {
    for (const definition of matchingSlots(node)) {
      const position = formatPosition(treePath, definition.attribute);
      const parsedReference = stringAttribute(node, definition.attribute);
      if (parsedReference == null) continue;
      const reference =
        definition.node === "image"
          ? (takeExactMarkdownReference(exactReferences, node, "image") ?? "")
          : definition.node === "link"
            ? (takeExactMarkdownReference(exactReferences, node, "link") ?? "")
            : parsedReference;
      if (
        definition.conditional === "proven-download" &&
        options.includeGenericLinkCandidates !== true &&
        !provenDownloadsUnambiguouslyContain(reference, provenDownloadPaths) &&
        !isCanonicalAssetReference(reference) &&
        !usesReservedAssetScheme(reference, parsedReference)
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
        kind: classifyExactReference(reference, parsedReference),
        semantics: occurrenceSemantics(node, definition),
      };
      const replacement = replace(occurrence);
      if (replacement !== undefined) node.attributes[definition.attribute] = replacement;
    }
  });

  escapeMarkdownInlineTitlesForFormatting(ast);
  return formatTopikContent(ast);
}

function escapeMarkdownInlineTitlesForFormatting(root: TopikContentNode): void {
  walk(root, [], (node) => {
    if (node.type !== "image" && node.type !== "link") return;
    const title = stringAttribute(node, "title");
    if (title === undefined) return;
    node.attributes.title = title.replace(/[&"\\]/gu, (character) => {
      if (character === "&") return "&amp;";
      if (character === '"') return "&quot;";
      return "&#92;";
    });
  });
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

function classifyExactReference(
  reference: string,
  parsedReference: string,
): TopikAssetOccurrenceKind {
  if (usesReservedAssetScheme(reference, parsedReference)) {
    const validation = validateTopikAssetReference(reference);
    return reference === parsedReference && validation.valid && validation.kind === "asset"
      ? "asset"
      : "reserved-asset";
  }
  return reference === parsedReference ? classifyReference(reference) : "unsafe";
}

function usesReservedAssetScheme(reference: string, parsedReference: string): boolean {
  return hasReservedAssetScheme(reference) || hasReservedAssetScheme(parsedReference);
}

function hasReservedAssetScheme(value: string): boolean {
  let prefix = "";
  for (let index = 0; index < value.length && prefix.length < "asset:".length; index++) {
    if (value[index] === "%" && /^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      prefix += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      prefix += value[index];
    }
  }
  return /^asset:/iu.test(prefix);
}

function provenDownloadsUnambiguouslyContain(
  reference: string,
  paths: ReadonlySet<string>,
): boolean {
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
  if (reference.startsWith("asset:")) {
    const name = reference.slice("asset:".length);
    return /^auto-v1-[a-z2-7]{52}$/u.test(name)
      ? { valid: true, kind: "asset", name }
      : { valid: false, kind: "unsafe", failureKind: "local" };
  }
  if (/^https:\/\//iu.test(reference)) {
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

function isCanonicalAssetReference(reference: string): boolean {
  const validation = validateTopikAssetReference(reference);
  return validation.valid && validation.kind === "asset";
}

/** Remove invalid Asset-capable attributes before renderer transformation. */
export function removeInvalidTopikAssetReferences(root: TopikContentNode, source?: string): void {
  const invalidSourcePositions =
    source === undefined
      ? undefined
      : new Set(
          extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true })
            .filter(isInvalidRenderedAssetOccurrence)
            .map((occurrence) => occurrence.position),
        );
  walk(root, [], (node, treePath) => {
    for (const definition of matchingSlots(node)) {
      const reference = stringAttribute(node, definition.attribute);
      const sourceWasInvalid = invalidSourcePositions?.has(
        formatPosition(treePath, definition.attribute),
      );
      if (definition.conditional === "proven-download") {
        if (sourceWasInvalid === true) delete node.attributes[definition.attribute];
        continue;
      }
      if (
        reference !== undefined &&
        (sourceWasInvalid === true || !validateTopikAssetReference(reference).valid)
      ) {
        delete node.attributes[definition.attribute];
      }
    }
  });
}

function isInvalidRenderedAssetOccurrence(occurrence: TopikAssetOccurrence): boolean {
  if (occurrence.kind === "reserved-asset") return true;
  if (occurrence.kind !== "unsafe") return false;
  if (occurrence.slot !== "link.href") return true;
  const reference =
    occurrence.reference.length === 0 ? occurrence.parsedReference : occurrence.reference;
  const validation = validateTopikAssetReference(reference);
  return !validation.valid && validation.failureKind === "external";
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
      component.length > 0 &&
      (component === "." || component === ".." || !/[. ]$/u.test(component)),
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
  autolink?: boolean;
  kind: "image" | "link";
  label: string;
  reference: string;
  source: string;
}

interface ParsedMarkdownDestination {
  autolink: boolean;
  kind: "image" | "link";
  labelProof: string;
  parsedReference: string;
}

interface MarkdownInlineToken {
  type?: string;
  attrs?: Array<[string, string]> | null;
  children?: MarkdownInlineToken[] | null;
  content?: string;
  level?: number;
  map?: [number, number] | null;
  markup?: string;
  nesting?: number;
}

interface ExactMarkdownReferenceContext {
  images: Array<string | undefined>;
  links: Array<string | undefined>;
}

type ExactMarkdownReferences = Map<string, ExactMarkdownReferenceContext>;

function exactMarkdownReferences(source: string): ExactMarkdownReferences {
  const references: ExactMarkdownReferences = new Map();
  const definitions = parseMarkdownReferenceDefinitions(maskMarkdocTags(source));
  const tokens = new Markdoc.Tokenizer().tokenize(source) as MarkdownInlineToken[];
  const activeBlockMaps = new Map<number, [number, number]>();
  for (const token of tokens) {
    const level = token.level ?? 0;
    if (token.nesting === -1) activeBlockMaps.delete(level);
    if (token.map != null) activeBlockMaps.set(level, token.map);
    if (token.type !== "inline" || token.children == null) continue;
    const map = token.map ?? nearestBlockMap(activeBlockMaps, level);
    if (map === undefined) continue;
    const key = markdownContextKey(map);
    const context = references.get(key) ?? { images: [], links: [] };
    const scanned = scanMarkdownDestinations(maskMarkdocTags(token.content ?? ""), definitions);
    const parsed = parsedMarkdownDestinations(token.children);
    context.images.push(...pairMarkdownDestinations("image", parsed, scanned, definitions));
    context.links.push(...pairMarkdownDestinations("link", parsed, scanned, definitions));
    references.set(key, context);
  }
  return references;
}

function takeExactMarkdownReference(
  references: ExactMarkdownReferences,
  node: TopikContentNode,
  kind: MarkdownDestination["kind"],
): string | undefined {
  if (!Array.isArray(node.lines) || node.lines.length !== 2) return undefined;
  const context = references.get(markdownContextKey(node.lines as [number, number]));
  return context?.[kind === "image" ? "images" : "links"].shift();
}

function nearestBlockMap(
  activeBlockMaps: ReadonlyMap<number, [number, number]>,
  level: number,
): [number, number] | undefined {
  for (let candidate = level; candidate >= 0; candidate--) {
    const map = activeBlockMaps.get(candidate);
    if (map !== undefined) return map;
  }
  return undefined;
}

function markdownContextKey(map: readonly [number, number]): string {
  return `${map[0]}:${map[1]}`;
}

/**
 * Markdoc tag attributes are a separate parser context. Preserve byte and line offsets while
 * preventing Markdown-looking attribute strings from proving a Markdown node destination.
 */
function maskMarkdocTags(source: string): string {
  const masked = source.split("");
  for (let index = 0; index < source.length - 1; index++) {
    if (source[index] !== "{" || source[index + 1] !== "%" || isEscaped(source, index)) continue;
    let quote: '"' | "'" | undefined;
    let closing = -1;
    for (let cursor = index + 2; cursor < source.length - 1; cursor++) {
      const character = source[cursor];
      if (quote !== undefined) {
        if (character === quote && !isEscaped(source, cursor)) quote = undefined;
        continue;
      }
      if ((character === '"' || character === "'") && !isEscaped(source, cursor)) {
        quote = character;
        continue;
      }
      if (character === "%" && source[cursor + 1] === "}") {
        closing = cursor + 1;
        break;
      }
    }
    if (closing === -1) continue;
    for (let cursor = index; cursor <= closing; cursor++) {
      if (source[cursor] !== "\n" && source[cursor] !== "\r") masked[cursor] = " ";
    }
    index = closing;
  }
  return masked.join("");
}

function parsedMarkdownDestinations(
  children: readonly MarkdownInlineToken[],
): ParsedMarkdownDestination[] {
  const destinations: ParsedMarkdownDestination[] = [];
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child.type === "image") {
      const parsedReference = child.attrs?.find(([name]) => name === "src")?.[1];
      if (parsedReference !== undefined) {
        destinations.push({
          autolink: false,
          kind: "image",
          labelProof: child.content ?? "",
          parsedReference,
        });
      }
      continue;
    }
    if (child.type !== "link_open") continue;
    const parsedReference = child.attrs?.find(([name]) => name === "href")?.[1];
    if (parsedReference === undefined) continue;
    const closing = findMatchingLinkClose(children, index + 1);
    if (closing === -1) {
      destinations.push({
        autolink: child.markup === "autolink",
        kind: "link",
        labelProof: "",
        parsedReference,
      });
      continue;
    }
    destinations.push({
      autolink: child.markup === "autolink",
      kind: "link",
      labelProof: markdownInlineTokenSignature(children.slice(index + 1, closing)),
      parsedReference,
    });
  }
  return destinations;
}

function findMatchingLinkClose(children: readonly MarkdownInlineToken[], start: number): number {
  let depth = 1;
  for (let index = start; index < children.length; index++) {
    if (children[index].type === "link_open") depth++;
    if (children[index].type === "link_close" && --depth === 0) return index;
  }
  return -1;
}

function pairMarkdownDestinations(
  kind: MarkdownDestination["kind"],
  parsed: readonly ParsedMarkdownDestination[],
  scanned: readonly MarkdownDestination[],
  definitions: ReadonlyMap<string, string>,
): Array<string | undefined> {
  const parsedKind = parsed.filter((destination) => destination.kind === kind);
  const scannedKind = scanned.filter(
    (destination) =>
      destination.kind === kind && markdownDestinationParsesInOwnSpan(destination, definitions),
  );
  if (parsedKind.length !== scannedKind.length) return parsedKind.map(() => undefined);
  const pairs = parsedKind.map((destination, index) => {
    const candidate = scannedKind[index];
    const labelProof =
      kind === "image"
        ? candidate.label
        : markdownLabelTokenSignature(candidate.label, definitions);
    return markdownDestinationsMatch(candidate, destination) &&
      labelProof === destination.labelProof
      ? destination.autolink
        ? destination.parsedReference
        : candidate.reference
      : undefined;
  });
  return pairs.some((reference) => reference === undefined)
    ? parsedKind.map(() => undefined)
    : pairs;
}

function markdownDestinationParsesInOwnSpan(
  destination: MarkdownDestination,
  definitions: ReadonlyMap<string, string>,
): boolean {
  const definitionSource = markdownReferenceDefinitionSource(definitions);
  const source =
    definitionSource.length === 0
      ? destination.source
      : `${destination.source}\n\n${definitionSource}`;
  const tokens = new Markdoc.Tokenizer().tokenize(source) as Array<{
    type?: string;
    children?: MarkdownInlineToken[] | null;
  }>;
  const parsed = tokens.flatMap((token) =>
    token.type === "inline" && token.children != null
      ? parsedMarkdownDestinations(token.children)
      : [],
  );
  const ownKind = parsed.filter((candidate) => candidate.kind === destination.kind);
  if (ownKind.length !== 1) return false;
  const labelProof =
    destination.kind === "image"
      ? destination.label
      : markdownLabelTokenSignature(destination.label, definitions);
  return ownKind[0].labelProof === labelProof && markdownDestinationsMatch(destination, ownKind[0]);
}

function markdownDestinationsMatch(
  scanned: MarkdownDestination,
  parsed: ParsedMarkdownDestination,
): boolean {
  if (scanned.autolink === true || parsed.autolink) {
    return (
      scanned.autolink === true &&
      parsed.autolink &&
      (scanned.reference === parsed.parsedReference ||
        `mailto:${scanned.reference}` === parsed.parsedReference)
    );
  }
  return sameMarkdownDestination(scanned.reference, parsed.parsedReference);
}

function markdownLabelTokenSignature(
  label: string,
  definitions: ReadonlyMap<string, string>,
): string {
  const definitionSource = markdownReferenceDefinitionSource(definitions);
  const source = definitionSource.length === 0 ? label : `${label}\n\n${definitionSource}`;
  const inline = (
    new Markdoc.Tokenizer().tokenize(source) as Array<{
      type?: string;
      children?: MarkdownInlineToken[] | null;
    }>
  ).find((token) => token.type === "inline");
  return markdownInlineTokenSignature(inline?.children ?? []);
}

function markdownReferenceDefinitionSource(definitions: ReadonlyMap<string, string>): string {
  return [...definitions]
    .map(([definition, reference]) => `[${definition}]: ${reference}`)
    .join("\n");
}

function markdownInlineTokenSignature(tokens: readonly MarkdownInlineToken[]): string {
  return JSON.stringify(
    tokens.map((token) => ({
      attrs: token.attrs ?? null,
      content: token.content ?? "",
      markup: token.markup ?? "",
      nesting: token.nesting ?? 0,
      type: token.type ?? "",
    })),
  );
}

function scanMarkdownDestinations(
  source: string,
  definitions: ReadonlyMap<string, string>,
): MarkdownDestination[] {
  const destinations: MarkdownDestination[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "`" && !isEscaped(source, index)) {
      const width = countRun(source, index, "`");
      const closing = findClosingBacktickRun(source, index + width, width);
      if (closing !== -1) index = closing + width - 1;
      continue;
    }
    if (source[index] === "<" && !isEscaped(source, index)) {
      const closing = findUnescaped(source, ">", index + 1);
      if (closing !== -1) {
        const reference = source.slice(index + 1, closing);
        if (reference.length > 0) {
          destinations.push({
            autolink: true,
            kind: "link",
            label: reference,
            reference,
            source: source.slice(index, closing + 1),
          });
          index = closing;
          continue;
        }
      }
    }
    const image = source[index] === "!" && source[index + 1] === "[" && !isEscaped(source, index);
    if (source[index] === "[" && source[index - 1] === "!" && isEscaped(source, index - 1)) {
      continue;
    }
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
      destinations.push({ kind, label, reference, source: source.slice(index, end + 1) });
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
  while (/[\t\n\r ]/u.test(source[cursor] ?? "")) cursor++;
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
  if (reference.length === 0) return undefined;
  while (/[\t\n\r ]/u.test(source[cursor] ?? "")) cursor++;
  if (source[cursor] === ")") return { reference, end: cursor };

  const titleClosing =
    source[cursor] === '"'
      ? '"'
      : source[cursor] === "'"
        ? "'"
        : source[cursor] === "("
          ? ")"
          : undefined;
  if (titleClosing === undefined) return undefined;
  const titleEnd = findUnescaped(source, titleClosing, cursor + 1);
  if (titleEnd === -1) return undefined;
  cursor = titleEnd + 1;
  while (/[\t\n\r ]/u.test(source[cursor] ?? "")) cursor++;
  return source[cursor] === ")" ? { reference, end: cursor } : undefined;
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
    if (value[index] === "`") {
      const width = countRun(value, index, "`");
      const closing = findClosingBacktickRun(value, index + width, width);
      if (closing !== -1) {
        index = closing + width - 1;
        continue;
      }
    }
    if (value[index] === "[") {
      depth++;
    } else if (value[index] === "]") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findClosingBacktickRun(value: string, start: number, width: number): number {
  for (let index = start; index < value.length; index++) {
    if (value[index] !== "`") continue;
    const candidateWidth = countRun(value, index, "`");
    if (candidateWidth === width) return index;
    index += candidateWidth - 1;
  }
  return -1;
}

function countRun(value: string, start: number, character: string): number {
  let count = 0;
  while (value[start + count] === character) count++;
  return count;
}
