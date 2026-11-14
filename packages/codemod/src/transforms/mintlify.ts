import { components, validateTopikContent } from "@topik/content";
import { fromMarkdown, type Extension, type Handle } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter } from "micromark-extension-frontmatter";
// Build-time reuse keeps the content grammar and admission budgets aligned.
// The codemod bundle includes these internals; published consumers need no src.
import {
  assertSourceLimit,
  assertTreeLimits,
  CONTENT_LIMITS,
  ContentLimitError,
} from "../../../content/src/limits.js";
import { parserLimitSyntax } from "../../../content/src/parser-limits.js";
import { gfmFromMarkdown, gfmSyntax } from "../../../content/src/gfm.js";
import { headingIdSyntax } from "../../../content/src/heading-ids.js";
import { tagOptions } from "../../../content/src/tag-options.js";
import { tagSyntax } from "../../../remark-tags/src/syntax.js";
import { frontmatterEnd } from "./frontmatter";
import { jsxBoundarySyntax } from "./jsx-boundaries";

export interface TransformWarning {
  line: number;
  column: number;
  message: string;
}

export interface TransformResult {
  content: string;
  warnings: TransformWarning[];
  changed: boolean;
}

const CALLOUT_VARIANTS = new Map([
  ["Note", "info"],
  ["Info", "info"],
  ["Tip", "tip"],
  ["Check", "tip"],
  ["Warning", "warning"],
  ["Danger", "danger"],
]);

const BLOCK_TAGS = new Map([
  ["Tabs", "tabs"],
  ["Tab", "tab"],
  ["Steps", "steps"],
  ["Step", "step"],
  ["Card", "card"],
  ["CardGroup", "cardGrid"],
  ["Accordion", "accordion"],
  ["CodeGroup", "codeGroup"],
  ["CodeTab", "codeTab"],
]);

const UNSUPPORTED_TAGS = new Set([
  "Frame",
  "Image",
  "AccordionGroup",
  "Expandable",
  "Snippet",
  "Update",
  "Tooltip",
  "Icon",
]);

// Every convertible component maps to a block in the target registry.
const BLOCK_COMPONENT_NAMES = new Set([...CALLOUT_VARIANTS.keys(), ...BLOCK_TAGS.keys()]);

const TAG_NAME_RE = /[A-Z][A-Za-z0-9]*/;
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{[^}]*\}))/g;

export interface TransformOptions {
  /** Treat the source as MDX: refuse MDX-only ESM and expressions Topik would render as prose. */
  mdx?: boolean;
}

type SourceTree = ReturnType<typeof fromMarkdown>;

export function transformMintlify(source: string, options: TransformOptions = {}): TransformResult {
  const warnings: TransformWarning[] = [];
  // Micromark drops exactly one initial BOM before assigning offsets. Align
  // budget lookups with those offsets, then restore original-source ranges.
  const bomLength = source.startsWith("\uFEFF") ? 1 : 0;
  const bodyStart = frontmatterEnd(source);
  const kept = (): TransformResult => ({ content: source, warnings, changed: false });
  let mdxTree: SourceTree;
  try {
    // MDX has no indented code: read component bodies the way Mintlify does.
    mdxTree = parseSource(source, bomLength, true);
  } catch (error) {
    if (!(error instanceof ContentLimitError)) throw error;
    warn(warnings, source, 0, `${error.message}; source kept`);
    return kept();
  }
  if (options.mdx) {
    for (const { offset, message } of findMdxOnlySyntax(source, mdxTree, bomLength, bodyStart))
      warn(warnings, source, offset, message);
    if (warnings.length > 0) return kept();
  }

  const dedent = dedentBodies(source, mdxTree, bomLength, bodyStart);
  if ("warning" in dedent) {
    warn(warnings, source, dedent.warning.offset, dedent.warning.message);
    return kept();
  }
  // Dedenting removes leading whitespace only, so lines stay aligned with the
  // source; columns are shifted back by each line's stripped width.
  const text = dedent.source;
  const toSource = (warning: TransformWarning): TransformWarning => ({
    ...warning,
    column: warning.column + (dedent.strips[warning.line - 1] ?? 0),
  });
  let tree: SourceTree;
  try {
    // Markdown (Topik) semantics, after dedenting, decide what is literal code.
    tree = parseSource(text, bomLength, false);
  } catch (error) {
    if (!(error instanceof ContentLimitError)) throw error;
    warn(warnings, source, 0, `${error.message}; source kept`);
    return kept();
  }
  const result = convert(text, tree, bomLength, bodyStart, dedent.bodyLines, options.mdx ?? false);
  warnings.push(...result.warnings.map(toSource));
  if (!result.changed || warnings.length > 0) return kept();
  return { content: result.content, warnings, changed: true };
}

function parseSource(source: string, bomLength: number, mdx: boolean): SourceTree {
  assertSourceLimit(source);
  const tree = fromMarkdown(source, {
    // JSX wrappers must not become opaque HTML blocks: their Markdown children
    // can contain fenced or inline code whose original source ranges we retain.
    // Keep inline HTML tokenization so quoted attribute backticks stay in tags.
    extensions: [
      frontmatter(),
      ...gfmSyntax(),
      tagSyntax(
        Object.fromEntries(Object.entries(components).map(([name, { kind }]) => [name, { kind }])),
        tagOptions(components),
      ),
      headingIdSyntax(),
      jsxBoundarySyntax(BLOCK_COMPONENT_NAMES),
      { disable: { null: mdx ? ["htmlFlow", "codeIndented"] : ["htmlFlow"] } },
      parserLimitSyntax(source.slice(bomLength)),
    ],
    mdastExtensions: [
      {
        transforms: [
          (root) => {
            assertTreeLimits(root);
            return root;
          },
        ],
      },
      ...gfmFromMarkdown(),
      frontmatterFromMarkdown(),
      protectedMarkersFromMarkdown(),
      imageLabelsFromMarkdown(),
    ],
  });
  assertTreeLimits(tree);
  return tree;
}

function convert(
  source: string,
  tree: SourceTree,
  bomLength: number,
  bodyStart: number,
  bodyLines: ReadonlySet<number>,
  mdx: boolean,
): TransformResult {
  const warnings: TransformWarning[] = [];
  const kept = (): TransformResult => ({ content: source, warnings, changed: false });
  const protectedRanges = collectProtectedRanges(tree, bomLength);
  const containerRanges = collectContainerRanges(tree, bomLength);
  const lines = lineStarts(source);
  const fallbackEol = /\r?\n/u.exec(source)?.[0] ?? "\n";
  // Split lines keep the terminator style of the source line they came from.
  const eolAt = (offset: number): string => {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) return fallbackEol;
    return source[newline - 1] === "\r" ? "\r\n" : "\n";
  };
  // One-based source line for each one-based output line, for diagnostics.
  const outputLines: number[] = [];
  let out = "";
  const emit = (value: string, at: number, copied: boolean): void => {
    if (outputLines.length === 0) outputLines.push(lineIndex(lines, at) + 1);
    for (let i = value.indexOf("\n"); i >= 0; i = value.indexOf("\n", i + 1))
      outputLines.push(lineIndex(lines, copied ? at + i + 1 : at) + 1);
    out += value;
  };
  const copy = (start: number, end: number): void => emit(source.slice(start, end), start, true);
  // Tags start their own lines: drop whitespace-only indentation before them.
  const startLine = (at: number): void => {
    const lineStart = out.lastIndexOf("\n") + 1;
    if (!/\S/u.test(out.slice(lineStart))) out = out.slice(0, lineStart);
    else emit(eolAt(at), at, false);
  };

  copy(0, bodyStart);
  let cursor = bodyStart;
  let changed = false;
  let firstTag = 0;

  while (cursor < source.length) {
    const next = findNextTag(source, cursor, protectedRanges);
    if (next == null) {
      copy(cursor, source.length);
      break;
    }

    copy(cursor, next.start);
    if (UNSUPPORTED_TAGS.has(next.name)) {
      warn(warnings, source, next.start, `<${next.name}> has no equivalent Topik component`);
      copy(next.start, next.end);
      cursor = next.end;
      continue;
    }

    const container = containerRanges[firstRangeAfter(containerRanges, next.start)];
    if (container && next.start >= container.start) {
      warn(
        warnings,
        source,
        next.start,
        "JSX inside a Markdown list or blockquote cannot be converted safely; source kept",
      );
      return kept();
    }

    if (!changed) firstTag = next.start;
    changed = true;
    const name = CALLOUT_VARIANTS.has(next.name) ? "callout" : BLOCK_TAGS.get(next.name)!;
    if (next.kind === "close") {
      if (next.rawAttrs.length > 0)
        warn(warnings, source, next.attrsStart, `Closing </${next.name}> has attributes`);
      startLine(next.start);
      emit(`{% /${name} %}`, next.start, false);
    } else {
      const attrs = parseAttrs(next, name, source, warnings);
      if (CALLOUT_VARIANTS.has(next.name))
        attrs.unshift(`variant=${JSON.stringify(CALLOUT_VARIANTS.get(next.name))}`);
      startLine(next.start);
      emit(
        `{% ${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}${next.kind === "selfclose" ? " /%}" : " %}"}`,
        next.start,
        false,
      );
    }
    if (!/^\r?\n/u.test(source.slice(next.end, next.end + 2)))
      emit(eolAt(next.end), next.end, false);
    cursor = next.end;
  }

  // Conversion is transactional: never claim a partial or invalid migration.
  if (warnings.length > 0) return kept();
  for (const code of indentedCodeIn(source, tree, bomLength, lines, mdx ? null : bodyLines))
    warn(
      warnings,
      source,
      code,
      bodyLines.has(lineIndex(lines, code))
        ? "Indented text inside a component body would become a code block (MDX reads it as text); source kept"
        : "Indented text would become a code block once renamed to .md (MDX reads it as text); source kept",
    );
  if (warnings.length > 0) return kept();
  const validation = validateTopikContent(out);
  if (!validation.valid) {
    const prefix = changed
      ? "Converted content is not valid Topik content; source kept"
      : "Source is not valid Topik content; source kept";
    if (validation.errors.length === 0) warn(warnings, source, firstTag, prefix);
    for (const diagnostic of validation.errors) {
      const sourceLines = [
        ...new Set(diagnostic.lines.map((line) => outputLines[line - 1] ?? line)),
      ];
      const position =
        sourceLines.length > 0
          ? { line: sourceLines[0], column: 1 }
          : lineColumnAt(source, firstTag);
      const where = sourceLines.length > 1 ? ` (lines ${sourceLines.join(", ")})` : "";
      warnings.push({
        ...position,
        message: `${prefix}: ${diagnostic.message} [${diagnostic.id}]${where}`,
      });
    }
    return kept();
  }
  if (!changed) return kept();
  return { content: out, warnings, changed: true };
}

interface DedentResult {
  source: string;
  /** Leading characters removed from each zero-based line. */
  strips: number[];
  /** Zero-based lines that belong to a converted component body. */
  bodyLines: Set<number>;
}

/**
 * Mintlify bodies are usually indented under their tag. MDX ignores that
 * indentation, but Markdown reads four or more spaces as code, so remove each
 * body's common indentation (cumulatively for nested components). Relative
 * indentation, such as nested lists and fenced code contents, is retained.
 */
function dedentBodies(
  source: string,
  tree: SourceTree,
  bomLength: number,
  bodyStart: number,
): DedentResult | { warning: { offset: number; message: string } } {
  const lines = lineStarts(source);
  const unchanged: DedentResult = {
    source,
    strips: lines.map(() => 0),
    bodyLines: new Set(),
  };
  const protectedRanges = collectProtectedRanges(tree, bomLength);
  const containerRanges = collectContainerRanges(tree, bomLength);
  // Pairs are recorded in opening order, so parents precede their children.
  const pairs: Array<{ open: FoundTag; close?: FoundTag; parent: number }> = [];
  const stack: number[] = [];
  for (let cursor = bodyStart; ;) {
    const tag = findNextTag(source, cursor, protectedRanges);
    if (tag == null) break;
    cursor = tag.end;
    // Leave unsupported or container-nested source to the conversion's warnings.
    if (UNSUPPORTED_TAGS.has(tag.name)) return unchanged;
    const container = containerRanges[firstRangeAfter(containerRanges, tag.start)];
    if (container && tag.start >= container.start) return unchanged;
    if (tag.kind === "open") {
      // Deeper nesting fails target validation; bound the per-line work here.
      if (stack.length >= CONTENT_LIMITS.treeDepth) return unchanged;
      pairs.push({ open: tag, parent: stack.at(-1) ?? -1 });
      stack.push(pairs.length - 1);
    } else if (tag.kind === "close") {
      const top = stack.pop();
      if (top === undefined || pairs[top].open.name !== tag.name) return unchanged;
      pairs[top].close = tag;
    }
  }
  if (stack.length > 0 || pairs.length === 0) return unchanged;

  // Fenced code content keeps its own indentation rules: strip it "up to" the
  // body indentation, as the fence itself would, without counting it.
  const fenceLines = new Set<number>();
  collectNodes(tree, (node) => {
    if (node.type !== "code") return;
    const start = node.position!.start.offset! + bomLength;
    if (isIndentedCodeNode(source, start)) return;
    const end = node.position!.end.offset! + bomLength;
    for (let line = lineIndex(lines, start) + 1; line <= lineIndex(lines, end); line++)
      fenceLines.add(line);
  });

  const strips = lines.map(() => 0);
  const bodyLines = new Set<number>();
  const skipped = new Set<number>();
  const lineText = (line: number): string =>
    source.slice(lines[line], line + 1 < lines.length ? lines[line + 1] : source.length);
  const indentation = (line: number): string =>
    /^[ \t]*/u.exec(lineText(line).slice(strips[line]))![0];
  const blank = (line: number): boolean => !/\S/u.test(lineText(line));
  for (const [index, pair] of pairs.entries()) {
    const openLine = lineIndex(lines, pair.open.start);
    if (
      pair.parent >= 0
        ? skipped.has(pair.parent)
        : isIndentedCode(source, lines, openLine, pair.open.start)
    ) {
      // Markdown reads a top-level tag indented as code: it is not converted.
      skipped.add(index);
      continue;
    }
    const close = pair.close!;
    const closeLine = lineIndex(lines, close.start);
    const body: number[] = [];
    for (let line = openLine + 1; line < closeLine; line++) body.push(line);
    if (closeLine > openLine && /\S/u.test(source.slice(lines[closeLine], close.start)))
      body.push(closeLine);
    for (const line of body) bodyLines.add(line);
    const counted = body.filter((line) => !blank(line) && !fenceLines.has(line));
    if (counted.length === 0) continue;
    const widths = counted.map((line) => indentation(line));
    const prefix = widths.reduce((shortest, width) =>
      width.length < shortest.length ? width : shortest,
    );
    for (const line of body) {
      if (blank(line)) continue;
      const width = indentation(line);
      if (!width.startsWith(prefix) && !prefix.startsWith(width))
        return {
          warning: {
            offset: lines[line],
            message: `Indentation inside <${pair.open.name}> mixes tabs and spaces and cannot be removed safely; source kept`,
          },
        };
    }
    if (prefix.length === 0) continue;
    for (const line of body) strips[line] += Math.min(prefix.length, indentation(line).length);
  }
  if (strips.every((strip) => strip === 0)) return { ...unchanged, bodyLines };
  let dedented = "";
  for (const [line, start] of lines.entries())
    dedented += source.slice(
      start + strips[line],
      line + 1 < lines.length ? lines[line + 1] : source.length,
    );
  return { source: dedented, strips, bodyLines };
}

function isIndentedCode(source: string, lines: number[], line: number, tagStart: number): boolean {
  const prefix = source.slice(lines[line], tagStart);
  if (/\S/u.test(prefix)) return false;
  let columns = 0;
  for (const character of prefix)
    columns = character === "\t" ? columns + 4 - (columns % 4) : columns + 1;
  return columns >= 4;
}

function indentedCodeIn(
  source: string,
  tree: SourceTree,
  bomLength: number,
  lines: number[],
  /** Lines to inspect; null inspects the whole document (MDX has no indented code). */
  bodyLines: ReadonlySet<number> | null,
): number[] {
  const offsets: number[] = [];
  collectNodes(tree, (node) => {
    if (node.type !== "code") return;
    const start = node.position!.start.offset! + bomLength;
    // Indented code starts at its indentation; fenced code starts at its fence.
    if (
      (bodyLines === null || bodyLines.has(lineIndex(lines, start))) &&
      isIndentedCodeNode(source, start)
    )
      offsets.push(start);
  });
  return offsets;
}

const MDX_ESM_RE = /^(?:import|export)(?=[\s{*])/u;

/** MDX-only syntax that Topik would silently render as prose. */
function findMdxOnlySyntax(
  source: string,
  tree: SourceTree,
  bomLength: number,
  bodyStart: number,
): Array<{ offset: number; message: string }> {
  const found: Array<{ offset: number; message: string }> = [];
  const esm = new Set<unknown>();
  for (const node of tree.children) {
    if (node.type !== "paragraph") continue;
    const start = node.position!.start.offset! + bomLength;
    // A start right after the initial BOM is the beginning of the document.
    if (start < bodyStart || (start > bomLength && source[start - 1] !== "\n")) continue;
    if (!MDX_ESM_RE.test(source.slice(start, start + 7))) continue;
    esm.add(node);
    found.push({
      offset: start,
      message: "MDX import/export statements have no Topik equivalent; source kept",
    });
  }
  const visit = (node: SourceNode): void => {
    // MDX parses expressions in link labels and image alt text; destinations
    // and titles are literal strings and are not label children.
    if (node.type === "link" || node.type === "linkReference") {
      node.children?.forEach(visit);
      return;
    }
    if (node.type === "image" || node.type === "imageReference") {
      (node as ImageNode).topikLabel?.forEach(visit);
      return;
    }
    if (PROTECTED_NODE_TYPES.has(node.type) || esm.has(node)) return;
    if (node.type === "text") {
      const start = node.position!.start.offset! + bomLength;
      const end = node.position!.end.offset! + bomLength;
      for (let i = source.indexOf("{", start); i >= 0 && i < end; i = source.indexOf("{", i + 1)) {
        let backslashes = 0;
        for (let previous = i - 1; previous >= start && source[previous] === "\\"; previous--)
          backslashes++;
        if (backslashes % 2 === 0)
          found.push({
            offset: i,
            message: "MDX expressions ({\u2026}) have no Topik equivalent; source kept",
          });
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree as SourceNode);
  return found.sort((a, b) => a.offset - b.offset);
}

interface FoundTag {
  start: number;
  end: number;
  kind: "open" | "close" | "selfclose";
  name: string;
  rawAttrs: string;
  attrsStart: number;
}

function findNextTag(
  source: string,
  from: number,
  protectedRanges: SourceRange[],
): FoundTag | null {
  let i = from;
  let rangeIndex = firstRangeAfter(protectedRanges, from);
  while (i < source.length) {
    const range = protectedRanges[rangeIndex];
    if (range && i >= range.start) {
      i = range.end;
      rangeIndex++;
      continue;
    }
    if (source[i] !== "<") {
      i++;
      continue;
    }
    let backslashes = 0;
    for (let previous = i - 1; previous >= 0 && source[previous] === "\\"; previous--)
      backslashes++;
    if (backslashes % 2 !== 0) {
      i++;
      continue;
    }
    const isClose = source[i + 1] === "/";
    const nameStart = isClose ? i + 2 : i + 1;
    const nameMatch = TAG_NAME_RE.exec(source.slice(nameStart));
    if (!nameMatch || nameMatch.index !== 0) {
      i++;
      continue;
    }
    const name = nameMatch[0];
    if (!CALLOUT_VARIANTS.has(name) && !BLOCK_TAGS.has(name) && !UNSUPPORTED_TAGS.has(name)) {
      i++;
      continue;
    }

    const afterName = nameStart + name.length;
    const tagEnd = findTagEnd(source, afterName);
    if (tagEnd < 0) return null;

    const interior = source.slice(afterName, tagEnd);
    const isSelfClose = !isClose && /\/\s*$/u.test(interior);
    const rawInterior = isSelfClose ? interior.replace(/\/\s*$/u, "") : interior;
    const leadingWs = rawInterior.length - rawInterior.trimStart().length;
    const rawAttrs = rawInterior.trim();
    const attrsStart = afterName + leadingWs;

    const kind: FoundTag["kind"] = isClose ? "close" : isSelfClose ? "selfclose" : "open";
    return { start: i, end: tagEnd + 1, kind, name, rawAttrs, attrsStart };
  }
  return null;
}

function findTagEnd(source: string, from: number): number {
  let inQuote: '"' | "'" | null = null;
  let braceDepth = 0;
  for (let j = from; j < source.length; j++) {
    const ch = source[j];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else {
      if (ch === '"' || ch === "'") inQuote = ch;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") {
        if (braceDepth > 0) braceDepth--;
      } else if (ch === ">" && braceDepth === 0) return j;
    }
  }
  return -1;
}

function parseAttrs(
  tag: FoundTag,
  targetName: string,
  source: string,
  warnings: TransformWarning[],
): string[] {
  const attrs: string[] = [];
  const raw = tag.rawAttrs;
  const definitions = components[targetName].attributes;
  const seen = new Set<string>();
  ATTR_RE.lastIndex = 0;
  let previousEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    if (raw.slice(previousEnd, match.index).trim())
      warn(
        warnings,
        source,
        tag.attrsStart + previousEnd,
        `Unsupported attributes on <${tag.name}>`,
      );
    previousEnd = ATTR_RE.lastIndex;
    const [, name, doubleQuoted, singleQuoted, jsExpression] = match;
    const offset = tag.attrsStart + match.index;
    if (jsExpression !== undefined) {
      warn(warnings, source, offset, `Dynamic JSX attribute ${name} is unsupported`);
      continue;
    }
    if (
      !Object.hasOwn(definitions, name) ||
      seen.has(name) ||
      (targetName === "callout" && name === "variant")
    ) {
      warn(warnings, source, offset, `Attribute ${name} is unsupported on <${tag.name}>`);
      continue;
    }
    seen.add(name);
    // JSX quoted attributes preserve backslashes literally; they are not JS strings.
    const value = doubleQuoted ?? singleQuoted ?? "";
    if (/\p{Cc}/u.test(value) || /&(?:#\w+|[a-z][a-z0-9]+);/iu.test(value)) {
      warn(warnings, source, offset, `Attribute ${name} cannot be converted safely`);
      continue;
    }
    const definition = definitions[name];
    if (definition.type === "boolean") {
      if (value !== "true" && value !== "false")
        warn(warnings, source, offset, `Attribute ${name} requires a boolean`);
      else attrs.push(`${name}=${value}`);
    } else if (definition.type === "number") {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number) || String(number) !== value)
        warn(warnings, source, offset, `Attribute ${name} requires a finite number`);
      else attrs.push(`${name}=${value}`);
    } else {
      attrs.push(`${name}=${JSON.stringify(value)}`);
    }
  }
  if (raw.slice(previousEnd).trim())
    warn(warnings, source, tag.attrsStart + previousEnd, `Unsupported attributes on <${tag.name}>`);
  return attrs;
}

function warn(warnings: TransformWarning[], source: string, offset: number, message: string): void {
  warnings.push({ ...lineColumnAt(source, offset), message });
}

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

interface SourceRange {
  start: number;
  end: number;
}

interface SourceNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SourceNode[];
}

const PROTECTED_NODE_TYPES = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "topikProtectedMarker",
]);

function protectedMarkersFromMarkdown(): Extension {
  // Retain Topik's paragraph boundaries and opaque directive headers without
  // grouping their children: actual JSX inside a directive body still migrates.
  const enter: Handle = function (token) {
    this.enter({ type: "topikProtectedMarker" } as never, token);
  };
  const exit: Handle = function (token) {
    this.exit(token);
  };
  const enterJsx: Handle = function (token) {
    // Count structural headers toward tree admission without making them opaque.
    this.enter({ type: "topikJsxBoundary" } as never, token);
  };
  return {
    enter: {
      topikTextTag: enter,
      topikFlowTag: enter,
      topikHeadingId: enter,
      topikJsxFlowBoundary: enterJsx,
    },
    exit: {
      topikTextTag: exit,
      topikFlowTag: exit,
      topikHeadingId: exit,
      topikJsxFlowBoundary: exit,
    },
  };
}

type ImageNode = SourceNode & { topikLabel?: SourceNode[] };

function imageLabelsFromMarkdown(): Extension {
  // Image alt text is flattened to a string; keep the parsed label children so
  // MDX-only syntax inside alt text can be located. The closing label marker is
  // entered last, once the label's children are complete.
  const enterLabelMarker: Handle = function () {
    const fragment = this.stack.at(-1) as unknown as SourceNode;
    const node = this.stack.at(-2) as unknown as ImageNode | undefined;
    if (node?.type === "image") node.topikLabel = [...(fragment.children ?? [])];
  };
  return { enter: { labelMarker: enterLabelMarker } };
}

function collectProtectedRanges(tree: SourceNode, offset: number): SourceRange[] {
  const ranges: SourceRange[] = [];
  function visit(node: SourceNode): void {
    // Resource titles, destinations and image alt text are opaque Markdown
    // values, not JSX bodies. Protect the whole resource: the block components
    // migrated here cannot be nested inside an inline link label either.
    if (PROTECTED_NODE_TYPES.has(node.type)) {
      ranges.push({
        start: node.position!.start.offset! + offset,
        end: node.position!.end.offset! + offset,
      });
    } else {
      node.children?.forEach(visit);
    }
  }
  visit(tree);
  return ranges;
}

function collectContainerRanges(tree: SourceNode, offset: number): SourceRange[] {
  const ranges: SourceRange[] = [];
  function visit(node: SourceNode): void {
    if (node.type === "list" || node.type === "blockquote") {
      ranges.push({
        start: node.position!.start.offset! + offset,
        end: node.position!.end.offset! + offset,
      });
    } else {
      node.children?.forEach(visit);
    }
  }
  visit(tree);
  return ranges;
}

function isIndentedCodeNode(source: string, start: number): boolean {
  return source[start] === " " || source[start] === "\t";
}

function collectNodes(tree: SourceTree, callback: (node: SourceNode) => void): void {
  const visit = (node: SourceNode): void => {
    callback(node);
    node.children?.forEach(visit);
  };
  visit(tree as SourceNode);
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** Zero-based index of the line containing an offset. */
function lineIndex(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function firstRangeAfter(ranges: SourceRange[], offset: number): number {
  let start = 0;
  let end = ranges.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (ranges[middle].end <= offset) start = middle + 1;
    else end = middle;
  }
  return start;
}
