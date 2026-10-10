import type { Code, ListItem, Node, Nodes } from "mdast";
import type { Extension, Handle } from "mdast-util-from-markdown";
import {
  TAG_LIMITS,
  TagSyntaxError,
  type TagBranchNode,
  type TagConditionalNode,
  type TagContainerNode,
  type TagDeclarations,
  type TagDiagnostic,
  type TagSyntaxOptions,
  type TagTextNode,
  type TagTextTemplate,
  type TagAttributeValue,
} from "./types.js";
import { invalidCodeTemplateHeader, parseTag, validateDeclarations } from "./grammar.js";
import { parseTextTemplate, TemplateSyntaxError } from "./templates.js";

// Structural traversal also visits children of nodes supplied by other plugins.
interface TreeNode extends Node {
  children?: TreeNode[];
  template?: TagTextTemplate;
  attributes?: Record<string, TagAttributeValue | null | undefined> | null;
}
interface Marker extends Node {
  type: "topikTagMarker";
  kind: "inline" | "block";
  value: string;
}
interface Frame {
  node: TagTextNode | TagContainerNode | TagConditionalNode | CodeTemplateFrame;
  marker: Marker;
  name: string;
  target: TreeNode[];
}
interface CodeTemplateFrame extends TreeNode {
  type: "tagCodeTemplateFrame";
  children: TreeNode[];
}

function isMarker(node: TreeNode): node is Marker {
  return node.type === "topikTagMarker";
}

function location(message: string, node: Node): TagDiagnostic {
  return { message, line: node.position?.start.line, column: node.position?.start.column };
}

function limitError(message: string, node: Node): never {
  throw new TagSyntaxError([{ ...location(message, node), id: "tag-content-limit" }]);
}

/** Bound the tree iteratively before entering the recursive conversion walk. */
function assertTreeLimits(root: TreeNode): void {
  const pending = [{ node: root, depth: 0 }];
  let count = 1;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > TAG_LIMITS.treeDepth)
      limitError(`Tag tree exceeds the depth limit of ${TAG_LIMITS.treeDepth}`, node);
    const children = node.children ?? [];
    count += children.length;
    const templates = node.type === "tagCodeTemplate" && node.template ? [node.template] : [];
    for (const value of Object.values(node.attributes ?? {}))
      if (value && typeof value === "object" && value.type === "topikTextTemplate")
        templates.push(value);
    for (const template of templates) count += 1 + template.segments.length;
    if (count > TAG_LIMITS.treeNodes)
      limitError(`Tag tree exceeds the node limit of ${TAG_LIMITS.treeNodes}`, node);
    for (const child of children) pending.push({ node: child, depth: depth + 1 });
  }
}

function convert(
  root: TreeNode,
  declarations: TagDeclarations,
  options: TagSyntaxOptions,
  closedFences: WeakSet<Code>,
  rawHeaders?: WeakMap<Node, string>,
): void {
  assertTreeLimits(root);
  const errors: TagDiagnostic[] = [];
  walk(root);
  if (errors.length) throw new TagSyntaxError(errors);
  // Markdown nesting and tag nesting contribute to the same final tree depth.
  assertTreeLimits(root);

  function walk(parent: TreeNode): void {
    if (!parent.children) return;
    const result: TreeNode[] = [];
    const stack: Frame[] = [];

    function append<T extends TreeNode>(node: T): void {
      (stack.at(-1)?.target ?? result).push(node);
    }

    function open(frame: Frame): void {
      if (stack.length >= TAG_LIMITS.treeDepth)
        limitError(`Tag nesting exceeds the depth limit of ${TAG_LIMITS.treeDepth}`, frame.marker);
      append(frame.node);
      stack.push(frame);
    }

    function close(name: string, marker: Marker): void {
      const current = stack.at(-1);
      if (!current || current.name !== name) {
        errors.push({
          ...location(`Mismatched closing tag ${name}`, marker),
          ...(name === "template code" || current?.node.type === "tagCodeTemplateFrame"
            ? { id: "topik-code-template-structure" }
            : {}),
        });
        return;
      }
      current.node.position =
        current.marker.position && marker.position
          ? { start: current.marker.position.start, end: marker.position.end }
          : undefined;
      if (current.node.type === "tagCodeTemplateFrame") {
        const node = current.node;
        const code = node.children[0] as Code | undefined;
        if (node.children.length !== 1 || code?.type !== "code" || !closedFences.has(code)) {
          errors.push({
            ...location(
              "Code template scope requires exactly one closed fenced code block",
              current.marker,
            ),
            id: "topik-code-template-structure",
          });
        } else if (!rawHeaders && invalidCodeTemplateHeader(code.lang, code.meta)) {
          errors.push({
            ...location("Code template language and metadata must fit one fence header", code),
            id: "topik-code-template-structure",
          });
        } else if (code.lang === "mermaid") {
          errors.push({
            ...location("Code templates cannot use the interpreted mermaid language", code),
            id: "topik-code-template-language",
          });
        } else {
          try {
            const template = parseTextTemplate(
              code.value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
              true,
            );
            Object.assign(node, {
              type: "tagCodeTemplate",
              lang: code.lang ?? null,
              meta: code.meta ?? null,
              template,
            });
            const rawHeader = rawHeaders?.get(code);
            if (rawHeader !== undefined) rawHeaders!.set(node, rawHeader);
            delete (node as TreeNode).children;
          } catch (error) {
            if (!(error instanceof TemplateSyntaxError)) throw error;
            errors.push({ ...location(error.message, code), id: error.id });
          }
        }
      }
      if (current.node.type === "tagConditional") {
        for (const branch of current.node.children) {
          const end = branch.children.at(-1)?.position?.end;
          if (branch.position && end) branch.position = { start: branch.position.start, end };
        }
      }
      stack.pop();
    }

    for (const child of parent.children) {
      if (!isMarker(child)) {
        walk(child);
        append(child);
        continue;
      }
      let tag: ReturnType<typeof parseTag>;
      try {
        tag = parseTag(child.value, options);
      } catch (error) {
        if (!(error instanceof TemplateSyntaxError)) throw error;
        errors.push({ ...location(error.message, child), id: error.id });
        continue;
      }
      if (typeof tag === "string") {
        errors.push(location(tag, child));
        continue;
      }
      // The tokenizer knows the context, including inside foreign node types.
      const phrasing = child.kind === "inline";
      switch (tag.kind) {
        case "codeTemplate": {
          if (phrasing) {
            errors.push({
              ...location("Code template markers require their own block lines", child),
              id: "topik-code-template-structure",
            });
          } else if (tag.close) {
            close("template code", child);
          } else {
            if (stack.some((frame) => frame.node.type === "tagCodeTemplateFrame"))
              errors.push({
                ...location("Code template scopes cannot nest", child),
                id: "topik-code-template-structure",
              });
            const node: CodeTemplateFrame = {
              type: "tagCodeTemplateFrame",
              children: [],
              position: child.position,
            };
            open({ node, marker: child, name: "template code", target: node.children });
          }
          break;
        }
        case "variable":
          if (!phrasing) errors.push(location("Variable tag is not valid here", child));
          else
            append({
              type: "tagVariable",
              path: tag.path,
              position: child.position,
            } satisfies Nodes);
          break;
        case "else": {
          const current = stack.at(-1);
          if (
            phrasing ||
            !current ||
            current.node.type !== "tagConditional" ||
            current.node.children.length > 1
          ) {
            errors.push({
              ...location("Misplaced else tag", child),
              ...(current?.node.type === "tagCodeTemplateFrame"
                ? { id: "topik-code-template-structure" }
                : {}),
            });
          } else {
            const branch: TagBranchNode = {
              type: "tagBranch",
              condition: null,
              children: [],
              position: child.position,
            };
            current.node.children.push(branch);
            current.target = branch.children;
          }
          break;
        }
        case "if": {
          if (phrasing) {
            errors.push(location("Block if tag is not valid here", child));
          } else if (tag.close) {
            close("if", child);
          } else {
            const branch: TagBranchNode = {
              type: "tagBranch",
              condition: tag.expression,
              children: [],
              position: child.position,
            };
            const node: TagConditionalNode = {
              type: "tagConditional",
              children: [branch],
              position: child.position,
            };
            open({ node, marker: child, name: "if", target: branch.children });
          }
          break;
        }
        case "component": {
          if (!Object.hasOwn(declarations, tag.name)) {
            errors.push(location(`Unknown tag ${tag.name}`, child));
            break;
          }
          const { kind } = declarations[tag.name];
          if ((kind === "inline") !== phrasing) {
            errors.push(
              location(
                `${kind === "block" ? "Block" : "Inline"} tag ${tag.name} is not valid here`,
                child,
              ),
            );
          } else if (tag.close) {
            close(tag.name, child);
          } else {
            const fields = {
              name: tag.name,
              attributes: { ...tag.attributes },
              position: child.position,
            };
            if (!phrasing && tag.selfClosing) {
              append({ ...fields, type: "tagLeaf", children: [] } satisfies Nodes);
            } else {
              const node: TagTextNode | TagContainerNode = {
                ...fields,
                type: phrasing ? "tagText" : "tagContainer",
                children: [],
              };
              if (tag.selfClosing) append(node);
              else open({ node, marker: child, name: tag.name, target: node.children });
            }
          }
          break;
        }
      }
    }
    for (const current of stack)
      errors.push({
        ...location(`Unclosed tag ${current.name}`, current.marker),
        ...(current.node.type === "tagCodeTemplateFrame"
          ? { id: "topik-code-template-structure" }
          : {}),
      });
    // Markdown saw separate markers and body blocks. Once grouped, only gaps
    // between the item's direct children count toward its spread flag.
    if (
      parent.type === "listItem" &&
      parent.children.some(isMarker) &&
      result.every((child) => child.position)
    ) {
      (parent as ListItem).spread = result.some((child, index) => {
        const previousEnd = result[index - 1]?.position?.end.line;
        return previousEnd !== undefined && child.position!.start.line > previousEnd + 1;
      });
    }
    parent.children = result;
  }
}

/** Build tag nodes after Markdown has established block and phrasing boundaries. */
export function tagFromMarkdown(
  declarations: TagDeclarations,
  options: TagSyntaxOptions = {},
): Extension {
  validateDeclarations(declarations, options);
  // Micromark emits a fence event only for a valid opening/closing fence.
  // Counting events avoids source heuristics around list/quote indentation.
  const fenceCounts = new WeakMap<Code, number>();
  const closedFences = new WeakSet<Code>();
  const exit: Handle = function (token) {
    this.exit(token);
  };
  return {
    enter: {
      topikTextTag: enter("inline"),
      topikFlowTag: enter("block"),
      codeFencedFence(token) {
        const node = this.stack.findLast((item) => item.type === "code") as Code | undefined;
        if (!node) return;
        const count = (fenceCounts.get(node) ?? 0) + 1;
        fenceCounts.set(node, count);
        if (count === 1 && options.fencedCodeHeaders)
          options.fencedCodeHeaders.set(
            node,
            this.sliceSerialize(token).replace(/^(?:`{3,}|~{3,})[ \t]*/, ""),
          );
        if (count === 2) closedFences.add(node);
      },
    },
    exit: { topikTextTag: exit, topikFlowTag: exit },
    transforms: [
      (tree) => {
        convert(tree, declarations, options, closedFences, options.fencedCodeHeaders);
      },
    ],
  };

  function enter(kind: Marker["kind"]): Handle {
    return function (token) {
      const marker: Marker = { type: "topikTagMarker", kind, value: this.sliceSerialize(token) };
      // Temporary markers are intentionally absent from public mdast node maps.
      // The transform consumes them all before returning the public tree.
      this.enter(marker as unknown as Nodes, token);
    };
  }
}
