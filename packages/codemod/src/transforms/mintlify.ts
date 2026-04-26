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

const CALLOUT_TAGS = new Set(["Note", "Tip", "Info", "Warning", "Check", "Danger"]);

const PASSTHROUGH_TAGS = new Set([
  "Frame",
  "Image",
  "Tabs",
  "Tab",
  "Steps",
  "Step",
  "CodeGroup",
  "Card",
  "CardGroup",
  "Accordion",
  "AccordionGroup",
  "Expandable",
  "Snippet",
  "Update",
  "Tooltip",
  "Icon",
]);

const TAG_NAME_RE = /[A-Z][A-Za-z0-9]*/;
const ATTR_RE =
  /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\{[^}]*\}))/g;

export function transformMintlify(source: string): TransformResult {
  const warnings: TransformWarning[] = [];
  let out = "";
  let cursor = 0;
  let changed = false;

  while (cursor < source.length) {
    const next = findNextTag(source, cursor);
    if (next == null) {
      out += source.slice(cursor);
      break;
    }

    out += source.slice(cursor, next.start);

    if (next.kind === "open" || next.kind === "selfclose") {
      const replacement = renderOpenTag(
        next.name,
        next.rawAttrs,
        next.kind === "selfclose",
        next.attrsStart,
        source,
        warnings,
      );
      out += replacement;
    } else {
      out += `{% /${markdocTagName(next.name)} %}`;
    }

    changed = true;
    cursor = next.end;
  }

  return { content: out, warnings, changed };
}

interface FoundTag {
  start: number;
  end: number;
  kind: "open" | "close" | "selfclose";
  name: string;
  rawAttrs: string;
  attrsStart: number;
}

function findNextTag(source: string, from: number): FoundTag | null {
  let i = from;
  while (i < source.length) {
    if (source[i] !== "<") {
      i++;
      continue;
    }
    if (isInsideCodeBlock(source, i)) {
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
    if (!isKnownComponent(name)) {
      i++;
      continue;
    }

    const afterName = nameStart + name.length;
    const tagEnd = findTagEnd(source, afterName);
    if (tagEnd < 0) return null;

    const interior = source.slice(afterName, tagEnd);
    const isSelfClose = interior.endsWith("/");
    const rawInterior = isSelfClose ? interior.slice(0, -1) : interior;
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
      else if (ch === ">") return j;
    }
  }
  return -1;
}

function isKnownComponent(name: string): boolean {
  return CALLOUT_TAGS.has(name) || PASSTHROUGH_TAGS.has(name);
}

function markdocTagName(componentName: string): string {
  if (CALLOUT_TAGS.has(componentName)) return "callout";
  return componentName.toLowerCase();
}

function renderOpenTag(
  componentName: string,
  rawAttrs: string,
  selfClose: boolean,
  attrsStart: number,
  source: string,
  warnings: TransformWarning[],
): string {
  const isCallout = CALLOUT_TAGS.has(componentName);
  const tagName = isCallout ? "callout" : markdocTagName(componentName);
  const attrParts: string[] = [];

  if (isCallout) {
    attrParts.push(`type="${componentName.toLowerCase()}"`);
  }

  if (rawAttrs.length > 0) {
    const collected = parseAttrs(rawAttrs, attrsStart, source, warnings);
    attrParts.push(...collected);
  }

  const attrString = attrParts.length > 0 ? ` ${attrParts.join(" ")}` : "";
  const closer = selfClose ? " /%}" : " %}";
  return `{% ${tagName}${attrString}${closer}`;
}

function parseAttrs(
  raw: string,
  attrsStart: number,
  source: string,
  warnings: TransformWarning[],
): string[] {
  const attrs: string[] = [];
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    const [, name, doubleQuoted, singleQuoted, jsExpression] = match;
    if (jsExpression !== undefined) {
      const { line, column } = lineColumnAt(source, attrsStart + match.index);
      warnings.push({
        line,
        column,
        message: `JSX expression in attribute (dropped): ${name}=${jsExpression}`,
      });
      continue;
    }
    // Re-emit as double-quoted Markdoc attribute. Values from a single-quoted
    // source may contain literal " that must be escaped.
    const wasDoubleQuoted = doubleQuoted !== undefined;
    const value = doubleQuoted ?? singleQuoted ?? "";
    const safeValue = wasDoubleQuoted ? value : value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    attrs.push(`${name}="${safeValue}"`);
  }
  return attrs;
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

function isInsideCodeBlock(source: string, offset: number): boolean {
  const before = source.slice(0, offset);
  const fences = before.match(/```/g);
  if (fences && fences.length % 2 === 1) return true;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineSoFar = before.slice(lineStart);
  const ticks = lineSoFar.match(/`/g);
  return ticks != null && ticks.length % 2 === 1;
}
