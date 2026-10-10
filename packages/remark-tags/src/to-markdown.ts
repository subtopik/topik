import type { Options, State } from "mdast-util-to-markdown";
import type {
  TagTextNode,
  TagLeafNode,
  TagContainerNode,
  TagVariableNode,
  TagConditionalNode,
  TagBranchNode,
  TagDeclarations,
  TagSyntaxOptions,
  TagCodeTemplateNode,
} from "./types.js";
import { TAG_LIMITS } from "./types.js";
import { writeTextTemplate } from "./templates.js";
import {
  hasControlCharacter,
  invalidCodeTemplateHeader,
  validConditionSource,
  variablePath,
  validateDeclarations,
} from "./grammar.js";

declare module "mdast-util-to-markdown" {
  interface ConstructNameMap {
    tagText: "tagText";
  }
}

type ComponentNode = TagTextNode | TagLeafNode | TagContainerNode;

function attributeEntries(node: ComponentNode): Array<[string, unknown]> {
  const property = Object.getOwnPropertyDescriptor(node, "attributes");
  if (!property) {
    if ("attributes" in node) throw new Error("Invalid inherited tag attributes");
    return [];
  }
  if (!property.enumerable || !("value" in property)) throw new Error("Invalid tag attributes");
  const attributes = property.value;
  if (attributes == null) return [];
  if (typeof attributes !== "object" || Array.isArray(attributes))
    throw new Error("Invalid tag attributes");
  const prototype = Object.getPrototypeOf(attributes);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Invalid tag attributes");
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(attributes)) {
    const descriptor = Object.getOwnPropertyDescriptor(attributes, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
      throw new Error("Invalid tag attributes");
    entries.push([key, descriptor.value]);
  }
  return entries.sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
}

function assertQuotedTemplateLength(source: string, state: State): void {
  let length = source.length + 3; // The t prefix and both quotes are source too.
  const table = state.stack.includes("tableCell");
  const label = state.stack.includes("label");
  for (let index = 0; index < source.length && length <= TAG_LIMITS.templateLength; index++) {
    const char = source[index];
    if (
      char === "\\" ||
      char === '"' ||
      (table && char === "|") ||
      (label && (char === "[" || char === "]"))
    )
      length++;
  }
  if (length > TAG_LIMITS.templateLength)
    throw new Error("Quoted template exceeds the text length limit");
}

function plainCodeTemplateNode(node: TagCodeTemplateNode): boolean {
  const prototype = Object.getPrototypeOf(node);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const fields = new Set(["type", "lang", "meta", "template", "position", "data"]);
  return Reflect.ownKeys(node).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
    return (
      typeof key === "string" && fields.has(key) && descriptor.enumerable && "value" in descriptor
    );
  });
}

function headerLength(value: string, metadata = false): number {
  let length = value.length + (metadata && value.startsWith(" ") ? 5 : 0);
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "&" || char === "\t") length += 4;
    else if (char === "\\" || char === "`") length += 5;
  }
  return length;
}

function headerSource(value: string, metadata = false): string {
  const escapes: Record<string, string> = {
    "&": "&amp;",
    "\\": "&#x5C;",
    "`": "&#x60;",
    "\t": "&#x9;",
  };
  const chunks: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    // Keep decoded leading spaces separate from the language/meta separator.
    const escaped =
      metadata && index === 0 && value[index] === " " ? "&#x20;" : escapes[value[index]];
    if (!escaped) continue;
    chunks.push(value.slice(start, index), escaped);
    start = index + 1;
  }
  chunks.push(value.slice(start));
  return chunks.join("");
}

function reservedCodeHead(value: string): boolean {
  return /^(?:filename|title|lines|startLine|highlight|focus|collapseAfter|wrap|added|removed)(?:[ \t=]|$)/.test(
    value,
  );
}

function literalCodeHeaderSource(value: string, metadata = false): string {
  return reservedCodeHead(value)
    ? `&#${value.charCodeAt(0)};${headerSource(value.slice(1), metadata)}`
    : headerSource(value, metadata);
}

function tagStart(
  node: ComponentNode,
  declarations: TagDeclarations,
  state: State,
  options: TagSyntaxOptions,
): string {
  const kind = node.type === "tagText" ? "inline" : "block";
  if (
    !node.name ||
    !Object.hasOwn(declarations, node.name) ||
    declarations[node.name].kind !== kind
  )
    throw new Error(`Tag ${node.name ?? "<missing>"} is not declared ${kind}`);
  if (node.type === "tagLeaf" && node.children?.length)
    throw new Error(`Leaf tag ${node.name} cannot contain children`);

  let result = `{% ${node.name}`;
  // Code-unit ordering makes output independent of the host's locale/ICU.
  for (const [name, value] of attributeEntries(node)) {
    if (!/^[a-z][A-Za-z0-9-]*$/.test(name)) throw new Error(`Invalid attribute ${name}`);
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean") result += ` ${name}=${value}`;
    else if (typeof value === "number" && Number.isFinite(value))
      result += ` ${name}=${Object.is(value, -0) ? "-0" : String(value)}`;
    else if (
      (typeof value === "string" &&
        !hasControlCharacter(value, options.escapedWhitespace?.[node.name]?.includes(name))) ||
      (options.expressions && typeof value === "object")
    ) {
      const template = typeof value !== "string";
      const source = template ? writeTextTemplate(value) : value;
      if (template) assertQuotedTemplateLength(source, state);
      let escaped = source.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      escaped = escaped.replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
      if (state.stack.includes("tableCell")) escaped = escaped.replaceAll("|", "\\|");
      // Directive labels scan brackets before the tag tokenizer sees its attributes.
      if (state.stack.includes("label"))
        escaped = escaped.replaceAll("[", "\\[").replaceAll("]", "\\]");
      result += ` ${name}=${template ? "t" : ""}"${escaped}"`;
    } else throw new Error(`Invalid value for attribute ${name}`);
  }
  return result;
}

function flowSuffix(node: TagContainerNode | TagBranchNode, body: string): string {
  if (!body) return "";
  // HTML blocks can continue until a blank line, swallowing the next tag marker.
  return node.children.at(-1)?.type === "html" ? "\n\n" : "\n";
}

/** Serialize tag nodes using the host writer for their Markdown children. */
export function tagToMarkdown(
  declarations: TagDeclarations,
  options: TagSyntaxOptions = {},
): Options {
  validateDeclarations(declarations, options);
  const handlers: NonNullable<Options["handlers"]> = {
    tagCodeTemplate(node: TagCodeTemplateNode): string {
      if (!options.expressions || !plainCodeTemplateNode(node))
        throw new Error("Invalid code template node");
      if (invalidCodeTemplateHeader(node.lang, node.meta))
        throw new Error("Invalid code template language or metadata");
      if (node.lang === "mermaid")
        throw new Error("Code templates cannot use the interpreted mermaid language");
      const value = writeTextTemplate(node.template, true);
      let backticks = 0;
      let tildes = 0;
      let backtickRun = 0;
      let tildeRun = 0;
      for (let index = 0; index < value.length; index++) {
        backtickRun = value[index] === "`" ? backtickRun + 1 : 0;
        tildeRun = value[index] === "~" ? tildeRun + 1 : 0;
        backticks = Math.max(backticks, backtickRun);
        tildes = Math.max(tildes, tildeRun);
      }
      const backtickLength = Math.max(3, backticks + 1);
      const tildeLength = Math.max(3, tildes + 1);
      const marker =
        node.lang?.includes("`") || node.meta?.includes("`") || tildeLength < backtickLength
          ? "~"
          : "`";
      const fenceLength = marker === "`" ? backtickLength : tildeLength;
      const encodedHeaderLength =
        headerLength(node.lang ?? "") +
        (reservedCodeHead(node.lang ?? "") ? 5 : 0) +
        (node.meta ? 1 + headerLength(node.meta, true) + (reservedCodeHead(node.meta) ? 5 : 0) : 0);
      const outputLength =
        42 + 2 * fenceLength + encodedHeaderLength + (value ? value.length + 1 : 0);
      if (outputLength > TAG_LIMITS.templateLength)
        throw new Error("Code template exceeds the text length limit");
      // Encode only string-parser-sensitive header characters. Passing a huge
      // fence as `before` to the host's safe() makes its position work quadratic.
      const header =
        literalCodeHeaderSource(node.lang ?? "") +
        (node.meta ? ` ${literalCodeHeaderSource(node.meta, true)}` : "");
      const fence = marker.repeat(fenceLength);
      return `{% template code %}\n${fence}${header}\n${value ? value + "\n" : ""}${fence}\n{% /template code %}`;
    },
    tagVariable(node: TagVariableNode): string {
      if (!options.expressions || !node.path || !variablePath.test(node.path))
        throw new Error("Invalid variable tag");
      return `{% $${node.path} %}`;
    },
    tagConditional(node: TagConditionalNode, _parent, state, info): string {
      if (!options.expressions || !node.children?.length || node.children.length > 2)
        throw new Error("Invalid conditional tag");
      const [first, alternate] = node.children;
      if (
        first.type !== "tagBranch" ||
        typeof first.condition !== "string" ||
        !validConditionSource(first.condition) ||
        (alternate && (alternate.type !== "tagBranch" || alternate.condition !== null))
      )
        throw new Error("Invalid conditional branches");
      const tracker = state.createTracker(info);
      let result = tracker.move(`{% if ${first.condition} %}\n`);
      for (const [index, branch] of node.children.entries()) {
        if (index > 0) result += tracker.move("{% else /%}\n");
        const body = state.containerFlow(branch, tracker.current());
        result += tracker.move(body + flowSuffix(branch, body));
      }
      return result + "{% /if %}";
    },
    tagText(node: TagTextNode, _parent, state, info): string {
      const start = tagStart(node, declarations, state, options);
      if (!node.children.length) return `${start} /%}`;
      const tracker = state.createTracker(info);
      const before = tracker.move(`${start} %}`);
      const after = `{% /${node.name} %}`;
      const previous = { emphasis: state.options.emphasis, strong: state.options.strong };
      const boundary = state.stack.lastIndexOf("tagText");
      // Reusing an enclosing mark's delimiter can pair across the tag markers.
      // Only alternate for marks opened since the last tag boundary: another
      // nested tag without a new mark must keep the already selected delimiter.
      for (const kind of ["emphasis", "strong"] as const) {
        if (state.stack.lastIndexOf(kind) > boundary)
          state.options[kind] = (previous[kind] ?? "*") === "*" ? "_" : "*";
      }
      const exit = state.enter("tagText");
      try {
        const body = state.containerPhrasing(node, { ...tracker.current(), before, after });
        return before + body + after;
      } finally {
        exit();
        state.options.emphasis = previous.emphasis;
        state.options.strong = previous.strong;
      }
    },
    tagLeaf(node: TagLeafNode, _parent, state): string {
      return `${tagStart(node, declarations, state, options)} /%}`;
    },
    tagContainer(node: TagContainerNode, _parent, state, info): string {
      const tracker = state.createTracker(info);
      const start = tracker.move(`${tagStart(node, declarations, state, options)} %}\n`);
      const body = state.containerFlow(node, tracker.current());
      return `${start}${body}${flowSuffix(node, body)}{% /${node.name} %}`;
    },
  };
  // mdast looks ahead at the next sibling to determine escaping. Without peek,
  // each nested inline tag is serialized twice, making writing exponential.
  for (const handler of Object.values(handlers)) Object.assign(handler, { peek: () => "{" });
  // Autolinks cannot decode escapes. Keep escaping in foreign phrasing contexts
  // such as directive labels, which do not necessarily enter "phrasing".
  return { unsafe: [{ character: "{", after: "%", notInConstruct: "autolink" }], handlers };
}
