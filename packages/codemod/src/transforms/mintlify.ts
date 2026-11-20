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
  // Both Mintlify grids become Topik columns: cards and columns are its cells.
  ["CardGroup", "columns"],
  ["Columns", "columns"],
  ["Column", "column"],
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

// Mintlify attribute names that Topik spells differently, per source component.
const ATTRIBUTE_ALIASES = new Map<string, Record<string, string>>([
  ["CardGroup", { cols: "count" }],
  ["Columns", { cols: "count" }],
  ["Accordion", { defaultOpen: "open" }],
]);

// Presentational Mintlify attributes without a Topik equivalent: dropped with a warning.
const DROPPABLE_ATTRIBUTES = new Map([
  ["Step", new Set(["icon"])],
  ["Tab", new Set(["icon"])],
  ["Accordion", new Set(["icon"])],
]);

const TAG_NAME_RE = /[A-Z][A-Za-z0-9]*/;
// Quoted values, braced expressions, or a bare boolean shorthand name.
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{[^}]*\}))|(?=\s|$))/g;
const NUMBER_LITERAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const LINE_END_RE = /\r\n|\r|\n/gu;
// Fence metadata words Mintlify reads as display options, not as a title.
const FENCE_OPTION_WORDS = new Set(["lines", "wrap", "expandable"]);

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
  // Notes describe an otherwise complete conversion, such as a dropped icon.
  return { content: result.content, warnings: result.notes.map(toSource), changed: true };
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
): TransformResult & { notes: TransformWarning[] } {
  const warnings: TransformWarning[] = [];
  const notes: TransformWarning[] = [];
  const kept = () => ({ content: source, warnings, notes: [], changed: false });
  const protectedRanges = collectProtectedRanges(tree, bomLength);
  const containerRanges = collectContainerRanges(tree, bomLength);
  const lines = lineStarts(source);
  const inlineTags = findInlineTags(source, tree, bomLength, bodyStart, protectedRanges);
  const fences = collectFences(source, tree, bomLength);
  const fallbackEol = /\r\n|\r|\n/u.exec(source)?.[0] ?? "\n";
  // Split lines keep the terminator style of the source line they came from.
  const eolAt = (offset: number): string => {
    return nextLineEnd(source, offset)?.[0] ?? fallbackEol;
  };
  // One-based source line for each one-based output line, for diagnostics.
  const outputLines: number[] = [];
  let out = "";
  const emit = (value: string, at: number, copied: boolean): void => {
    if (outputLines.length === 0) outputLines.push(lineIndex(lines, at) + 1);
    for (const end of value.matchAll(LINE_END_RE))
      outputLines.push(lineIndex(lines, copied ? at + end.index + end[0].length : at) + 1);
    out += value;
  };
  const copy = (start: number, end: number): void => emit(source.slice(start, end), start, true);
  // Tags start their own lines: drop whitespace-only indentation before them.
  const startLine = (at: number): void => {
    let lineStart = Math.max(out.lastIndexOf("\n"), out.lastIndexOf("\r")) + 1;
    // An initial BOM is not line content; keep it before the tag.
    if (lineStart === 0 && out.charCodeAt(0) === 0xfeff) lineStart = 1;
    if (!/[^ \t]/u.test(out.slice(lineStart))) out = out.slice(0, lineStart);
    else emit(eolAt(at), at, false);
  };
  // Mintlify code groups hold titled fences; Topik wraps each in a code tab.
  // Returns false when the body is not only fences, leaving it to validation.
  const emitCodeGroup = (open: FoundTag, close: FoundTag): boolean => {
    const inner = fences.filter((fence) => fence.start >= open.end && fence.end <= close.start);
    if (inner.length === 0) return false;
    let gap = open.end;
    for (const fence of inner) {
      if (/\S/u.test(source.slice(gap, fence.start))) return false;
      gap = fence.end;
    }
    if (/\S/u.test(source.slice(gap, close.start))) return false;
    const tabs: Array<{ fence: Fence; title: string; header: string }> = [];
    for (const fence of inner) {
      const header = /^(`{3,}|~{3,})[ \t]*(\S*)[ \t]*(.*?)[ \t]*$/u.exec(
        source.slice(fence.start, fence.infoEnd),
      );
      const title = header?.[3] ?? "";
      let problem: string | undefined;
      if (lines[lineIndex(lines, fence.start)] !== fence.start)
        problem = "Indented code block inside <CodeGroup> cannot be converted safely";
      else if (!header?.[2] || !title)
        problem = "Code block inside <CodeGroup> has no title after its language";
      else if (
        /[{}=\\&<>"'`\p{Cc}]/u.test(title) ||
        title.split(/[ \t]+/u).some((word) => FENCE_OPTION_WORDS.has(word))
      )
        problem = "Code block options inside <CodeGroup> cannot be converted safely";
      if (problem) warn(warnings, source, fence.start, `${problem}; source kept`);
      else tabs.push({ fence, title, header: `${header![1]}${header![2]}` });
    }
    parseAttrs(open, "codeGroup", source, warnings, notes);
    if (warnings.length > 0) return true;
    startLine(open.start);
    emit("{% codeGroup %}", open.start, false);
    for (const { fence, title, header } of tabs) {
      emit(eolAt(fence.start), fence.start, false);
      emit(`{% codeTab title=${JSON.stringify(title)} %}`, fence.start, false);
      emit(eolAt(fence.start), fence.start, false);
      // The title moves to the tab; the fence keeps only its language.
      emit(header, fence.start, false);
      copy(fence.infoEnd, fence.end);
      emit(eolAt(fence.end), fence.end, false);
      emit("{% /codeTab %}", fence.end, false);
    }
    emit(eolAt(close.start), close.start, false);
    emit("{% /codeGroup %}", close.start, false);
    return true;
  };

  copy(0, bodyStart);
  let cursor = bodyStart;
  let changed = false;
  let firstTag = 0;
  const openTags: FoundTag[] = [];
  // Reported after indented code, which often causes a mismatch after dedenting.
  let nesting: { offset: number; message: string } | undefined;

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

    const inline = inlineTags.get(next.start);
    if (inline !== undefined) {
      warn(
        warnings,
        source,
        next.start,
        `JSX inside ${inline} cannot be converted to a block component safely; source kept`,
      );
      return kept();
    }

    if (next.kind === "close") {
      const open = openTags.pop();
      if (open?.name !== next.name)
        nesting ??= {
          offset: next.start,
          message: open
            ? `Closing </${next.name}> does not match <${open.name}>; source kept`
            : `Closing </${next.name}> has no matching opening tag; source kept`,
        };
    }

    if (!changed) firstTag = next.start;
    changed = true;
    let end = next.end;
    const name = CALLOUT_VARIANTS.has(next.name) ? "callout" : BLOCK_TAGS.get(next.name)!;
    const groupClose =
      next.kind === "open" && next.name === "CodeGroup"
        ? findNextTag(source, next.end, protectedRanges)
        : null;
    if (
      groupClose?.kind === "close" &&
      groupClose.name === "CodeGroup" &&
      emitCodeGroup(next, groupClose)
    ) {
      if (warnings.length > 0) return kept();
      end = groupClose.end;
    } else if (next.kind === "close") {
      if (next.rawAttrs.length > 0)
        warn(warnings, source, next.attrsStart, `Closing </${next.name}> has attributes`);
      startLine(next.start);
      emit(`{% /${name} %}`, next.start, false);
    } else {
      if (next.kind === "open") openTags.push(next);
      const attrs = parseAttrs(next, name, source, warnings, notes);
      if (CALLOUT_VARIANTS.has(next.name))
        attrs.unshift(`variant=${JSON.stringify(CALLOUT_VARIANTS.get(next.name))}`);
      startLine(next.start);
      emit(
        `{% ${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}${next.kind === "selfclose" ? " /%}" : " %}"}`,
        next.start,
        false,
      );
    }
    if (source[end] !== "\n" && source[end] !== "\r") emit(eolAt(end), end, false);
    cursor = end;
  }
  const unclosed = openTags.pop();
  if (unclosed)
    nesting ??= {
      offset: unclosed.start,
      message: `<${unclosed.name}> is never closed; source kept`,
    };

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
  if (nesting && warnings.length === 0) warn(warnings, source, nesting.offset, nesting.message);
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
  return { content: out, warnings, notes, changed: true };
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
    // A multi-line opening tag ends on a later line; its attributes are not body.
    const openEndLine = lineIndex(lines, pair.open.end - 1);
    const body: number[] = [];
    for (let line = openEndLine + 1; line < closeLine; line++) body.push(line);
    if (closeLine > openEndLine && /\S/u.test(source.slice(lines[closeLine], close.start)))
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
    if (start < bodyStart || (start > bomLength && !/[\r\n]/u.test(source[start - 1]))) continue;
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
  notes: TransformWarning[],
): string[] {
  const attrs: string[] = [];
  const raw = tag.rawAttrs;
  const definitions = components[targetName].attributes;
  const aliases = ATTRIBUTE_ALIASES.get(tag.name) ?? {};
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
    const [, sourceName, doubleQuoted, singleQuoted, jsExpression] = match;
    const offset = tag.attrsStart + match.index;
    // JSX quoted attributes preserve backslashes literally; they are not JS strings.
    let value = doubleQuoted ?? singleQuoted;
    let literal: "string" | "number" | "boolean" = "string";
    if (jsExpression !== undefined) {
      // Only literal numbers and booleans are static; anything else is code.
      value = jsExpression.slice(1, -1).trim();
      if (value === "true" || value === "false") literal = "boolean";
      else if (NUMBER_LITERAL_RE.test(value)) literal = "number";
      else {
        warn(warnings, source, offset, `Dynamic JSX attribute ${sourceName} is unsupported`);
        continue;
      }
    } else if (value === undefined) {
      // JSX boolean shorthand: `<Accordion defaultOpen>`.
      value = "true";
      literal = "boolean";
    }
    const name = Object.hasOwn(aliases, sourceName) ? aliases[sourceName] : sourceName;
    if (
      !Object.hasOwn(definitions, name) &&
      literal === "string" &&
      DROPPABLE_ATTRIBUTES.get(tag.name)?.has(sourceName)
    ) {
      warn(
        notes,
        source,
        offset,
        `Attribute ${sourceName} on <${tag.name}> has no Topik equivalent and was dropped`,
      );
      continue;
    }
    if (
      !Object.hasOwn(definitions, name) ||
      seen.has(name) ||
      (targetName === "callout" && name === "variant")
    ) {
      warn(warnings, source, offset, `Attribute ${sourceName} is unsupported on <${tag.name}>`);
      continue;
    }
    seen.add(name);
    if (
      literal === "string" &&
      (/\p{Cc}/u.test(value) || /&(?:#\w+|[a-z][a-z0-9]+);/iu.test(value))
    ) {
      warn(warnings, source, offset, `Attribute ${sourceName} cannot be converted safely`);
      continue;
    }
    const definition = definitions[name];
    if (definition.type === "boolean") {
      if (literal === "number" || (value !== "true" && value !== "false"))
        warn(warnings, source, offset, `Attribute ${sourceName} requires a boolean`);
      else attrs.push(`${name}=${value}`);
    } else if (definition.type === "number") {
      const number = Number(value);
      if (
        literal === "boolean" ||
        !value.trim() ||
        !Number.isFinite(number) ||
        String(number) !== value
      )
        warn(warnings, source, offset, `Attribute ${sourceName} requires a finite number`);
      else attrs.push(`${name}=${value}`);
    } else if (literal !== "string") {
      warn(warnings, source, offset, `Attribute ${sourceName} requires a string`);
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
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n" || (source[i] === "\r" && source[i + 1] !== "\n")) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
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

const INLINE_CONTEXTS = new Map([
  ["paragraph", "a paragraph with other text"],
  ["heading", "a Markdown heading"],
  ["table", "a Markdown table"],
]);

/**
 * Tags in a phrasing context, mapped to that context's description. Block
 * components always start their own lines, so converting a tag in a table
 * cell, a heading or among paragraph text would move or split that content.
 * A paragraph that holds only components (as `<Note>Hi</Note>` does) is a
 * block position, as MDX itself reads it.
 */
function findInlineTags(
  source: string,
  tree: SourceTree,
  bomLength: number,
  bodyStart: number,
  protectedRanges: SourceRange[],
): Map<number, string> {
  const ranges: Array<SourceRange & { type: string }> = [];
  collectNodes(tree, (node) => {
    if (!INLINE_CONTEXTS.has(node.type)) return;
    const start = node.position!.start.offset! + bomLength;
    const end = node.position!.end.offset! + bomLength;
    // Paragraphs, headings and tables do not nest within each other.
    if (ranges.length === 0 || start >= ranges.at(-1)!.end)
      ranges.push({ start, end, type: node.type });
  });
  const inline = new Map<number, string>();
  if (ranges.length === 0) return inline;
  let index = 0;
  let group: FoundTag[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    const range = ranges[index];
    // Depth is relative to the range: closers may end components opened before it,
    // so only text at the outermost depth reached lies outside every component.
    let depth = 0;
    let outermost = 0;
    const text: Array<{ start: number; end: number; depth: number }> = [];
    let position = range.start;
    for (const tag of group) {
      text.push({ start: position, end: tag.start, depth });
      if (tag.kind === "open") depth++;
      else if (tag.kind === "close") outermost = Math.min(outermost, --depth);
      position = tag.end;
    }
    text.push({ start: position, end: range.end, depth });
    if (
      range.type !== "paragraph" ||
      text.some(
        (segment) =>
          segment.depth === outermost && /\S/u.test(source.slice(segment.start, segment.end)),
      )
    )
      for (const tag of group) inline.set(tag.start, INLINE_CONTEXTS.get(range.type)!);
    group = [];
  };
  for (let cursor = bodyStart; ;) {
    const tag = findNextTag(source, cursor, protectedRanges);
    if (tag == null) break;
    cursor = tag.end;
    while (index < ranges.length && ranges[index].end <= tag.start) {
      flush();
      index++;
    }
    if (index >= ranges.length) break;
    if (tag.start >= ranges[index].start) group.push(tag);
  }
  if (index < ranges.length) flush();
  return inline;
}

interface Fence extends SourceRange {
  /** End of the opening fence line, before its line ending. */
  infoEnd: number;
}

function collectFences(source: string, tree: SourceTree, bomLength: number): Fence[] {
  const fences: Fence[] = [];
  collectNodes(tree, (node) => {
    if (node.type !== "code") return;
    const start = node.position!.start.offset! + bomLength;
    if (isIndentedCodeNode(source, start)) return;
    const end = node.position!.end.offset! + bomLength;
    const infoEnd = Math.min(nextLineEnd(source, start)?.index ?? end, end);
    fences.push({ start, end, infoEnd });
  });
  return fences;
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

function nextLineEnd(source: string, from: number): RegExpExecArray | null {
  const lineEnd = new RegExp(LINE_END_RE);
  lineEnd.lastIndex = from;
  return lineEnd.exec(source);
}

/** Line starts after LF, CRLF and lone CR terminators, as Markdown reads them. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (const end of source.matchAll(LINE_END_RE)) starts.push(end.index + end[0].length);
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
