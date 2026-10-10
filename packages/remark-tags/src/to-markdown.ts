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
} from "./types.js";
import {
  hasControlCharacter,
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
  for (const name of Object.keys(node.attributes ?? {}).sort()) {
    if (!/^[a-z][A-Za-z0-9-]*$/.test(name)) throw new Error(`Invalid attribute ${name}`);
    const value = node.attributes![name];
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean") result += ` ${name}=${value}`;
    else if (typeof value === "number" && Number.isFinite(value))
      result += ` ${name}=${Object.is(value, -0) ? "-0" : String(value)}`;
    else if (
      typeof value === "string" &&
      !hasControlCharacter(value, options.escapedWhitespace?.[node.name]?.includes(name))
    ) {
      let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      escaped = escaped.replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
      if (state.stack.includes("tableCell")) escaped = escaped.replaceAll("|", "\\|");
      // Directive labels scan brackets before the tag tokenizer sees its attributes.
      if (state.stack.includes("label"))
        escaped = escaped.replaceAll("[", "\\[").replaceAll("]", "\\]");
      result += ` ${name}="${escaped}"`;
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
