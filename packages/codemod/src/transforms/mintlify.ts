import { components, validateTopikContent } from "@topik/content";
import { fromMarkdown, type Extension, type Handle } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter } from "micromark-extension-frontmatter";
// Build-time reuse keeps the content grammar and admission budgets aligned.
// The codemod bundle includes these internals; published consumers need no src.
import {
  assertSourceLimit,
  assertTreeLimits,
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
const ATTR_RE =
  /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\{[^}]*\}))/g;

export function transformMintlify(source: string): TransformResult {
  const warnings: TransformWarning[] = [];
  // Micromark drops exactly one initial BOM before assigning offsets. Align
  // budget lookups with those offsets, then restore original-source ranges.
  const bomLength = source.startsWith("\uFEFF") ? 1 : 0;
  const parserSource = source.slice(bomLength);
  let tree: ReturnType<typeof fromMarkdown>;
  try {
    assertSourceLimit(source);
    tree = fromMarkdown(source, {
      // JSX wrappers must not become opaque HTML blocks: their Markdown children
      // can contain fenced or inline code whose original source ranges we retain.
      // Keep inline HTML tokenization so quoted attribute backticks stay in tags.
      extensions: [
        frontmatter(),
        ...gfmSyntax(),
        tagSyntax(
          Object.fromEntries(
            Object.entries(components).map(([name, { kind }]) => [name, { kind }]),
          ),
          tagOptions(components),
        ),
        headingIdSyntax(),
        jsxBoundarySyntax(BLOCK_COMPONENT_NAMES),
        { disable: { null: ["htmlFlow"] } },
        parserLimitSyntax(parserSource),
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
      ],
    });
    assertTreeLimits(tree);
  } catch (error) {
    if (!(error instanceof ContentLimitError)) throw error;
    warn(warnings, source, 0, `${error.message}; source kept`);
    return { content: source, warnings, changed: false };
  }
  const protectedRanges = collectProtectedRanges(tree, bomLength);
  const bodyStart = frontmatterEnd(source);
  let out = source.slice(0, bodyStart);
  let cursor = bodyStart;
  let changed = false;
  let firstTag = 0;

  while (cursor < source.length) {
    const next = findNextTag(source, cursor, protectedRanges);
    if (next == null) {
      out += source.slice(cursor);
      break;
    }

    out += source.slice(cursor, next.start);
    if (UNSUPPORTED_TAGS.has(next.name)) {
      warn(warnings, source, next.start, `<${next.name}> has no equivalent Topik component`);
      out += source.slice(next.start, next.end);
      cursor = next.end;
      continue;
    }

    if (!changed) firstTag = next.start;
    changed = true;
    const name = CALLOUT_VARIANTS.has(next.name) ? "callout" : BLOCK_TAGS.get(next.name)!;
    if (next.kind === "close") {
      if (next.rawAttrs.length > 0)
        warn(warnings, source, next.attrsStart, `Closing </${next.name}> has attributes`);
      if (!out.endsWith("\n") && out.length > 0) out += "\n";
      out += `{% /${name} %}`;
    } else {
      const attrs = parseAttrs(next, name, source, warnings);
      if (CALLOUT_VARIANTS.has(next.name))
        attrs.unshift(`variant=${JSON.stringify(CALLOUT_VARIANTS.get(next.name))}`);
      if (out.length > 0 && !out.endsWith("\n") && /\S/u.test(out.slice(out.lastIndexOf("\n") + 1)))
        out += "\n";
      out += `{% ${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}${next.kind === "selfclose" ? " /%}" : " %}"}`;
    }
    if (source[next.end] !== "\n") out += "\n";
    cursor = next.end;
  }

  // Conversion is transactional: never claim a partial or invalid migration.
  if (warnings.length > 0) return { content: source, warnings, changed: false };
  if (!validateTopikContent(out).valid) {
    warn(
      warnings,
      source,
      firstTag,
      changed
        ? "Converted content is not valid Topik content; source kept"
        : "Source is not valid Topik content; source kept",
    );
    return { content: source, warnings, changed: false };
  }
  if (!changed) return { content: source, warnings, changed: false };
  return { content: out, warnings, changed: true };
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
      if (ch === "\\") {
        j++;
        continue;
      }
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
    const value = decodeQuoted(doubleQuoted ?? singleQuoted ?? "", doubleQuoted !== undefined);
    if (value === undefined || /\p{Cc}/u.test(value) || /&(?:#\w+|[a-z][a-z0-9]+);/iu.test(value)) {
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

function decodeQuoted(raw: string, doubleQuoted: boolean): string | undefined {
  if (doubleQuoted) {
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return undefined;
    }
  }
  let result = "";
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== "\\") {
      result += raw[index];
      continue;
    }
    const next = raw[++index];
    if (next !== "'" && next !== '"' && next !== "\\") return undefined;
    result += next;
  }
  return result;
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
