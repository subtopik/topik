import type { ContentDocument, TextTemplate, TreeNode } from "./model.js";
import type { Expression } from "./expressions.js";
import { validPath } from "./expressions.js";
import { components, type Registry } from "./registry.js";
import { validateDocument } from "./validation.js";
import { assertDataLimits, ContentLimitError, CONTENT_LIMITS } from "./limits.js";
import { indexDocument, materializeReferences } from "./document-index.js";
import { footnoteKey } from "./footnotes.js";
import { assignAnchorIds, isAnchorNode } from "./headings.js";
import { inlineParentTypes } from "./node-grammar.js";
import { writeDocument } from "./writer.js";
import { hasControlCharacters } from "./text-controls.js";

export class ContentEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentEvaluationError";
  }
}

/** @internal Expected evaluation failures retain their public diagnostic identity. */
export class TemplateEvaluationError extends ContentEvaluationError {
  readonly lines: number[];
  readonly column: number | undefined;
  readonly type: string;

  constructor(
    readonly id: string,
    node: TreeNode,
    message: string,
    readonly attribute?: string,
    readonly variable?: string,
  ) {
    super(message);
    this.name = "TemplateEvaluationError";
    this.lines = node.position ? [node.position.start.line] : [];
    this.column = node.position?.start.column;
    this.type = node.type;
  }
}

function dataValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    Array.isArray(value) ||
    (typeof value === "object" &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
  );
}

function lookup(
  context: Record<string, unknown>,
  path: string[],
  fail: (kind: "path" | "missing" | "type", message: string) => never = (_kind, message) => {
    throw new ContentEvaluationError(message);
  },
): unknown {
  if (!validPath(path)) fail("path", "Unsafe variable path");
  let current: unknown = context;
  for (const part of path) {
    if (
      !dataValue(current) ||
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    )
      fail("type", `Cannot read $${path.join(".")}`);
    const descriptor = Object.getOwnPropertyDescriptor(current, part);
    if (!descriptor) fail("missing", `Missing variable $${path.join(".")}`);
    if (!("value" in descriptor)) fail("type", `Missing variable $${path.join(".")}`);
    current = descriptor.value;
  }
  if (!dataValue(current)) fail("type", `Non-data value $${path.join(".")}`);
  return current;
}

// Markdoc treats only false and null as false, including for the literal 0 and "".
function truthy(value: unknown): boolean {
  return value !== false && value !== null;
}

/** Bound public source context before joining a potentially long path. */
function variableLabel(path: string[]): string | undefined {
  const pathLength = path.reduce((length, part) => length + part.length + 1, -1);
  return pathLength <= 256 ? path.join(".") : undefined;
}

/** Body and condition lookups report the authored node and path, never the supplied value. */
function lookupAt(context: Record<string, unknown>, path: string[], node: TreeNode): unknown {
  return lookup(context, path, (kind, message) => {
    throw new TemplateEvaluationError(
      kind === "path" ? "topik-variable-path" : `topik-variable-${kind}`,
      node,
      message,
      undefined,
      variableLabel(path),
    );
  });
}

function evaluate(
  expression: Expression,
  context: Record<string, unknown>,
  node: TreeNode,
): unknown {
  if (expression.type === "literal") return expression.value;
  if (expression.type === "variable") return lookupAt(context, expression.path, node);
  const [left, right] = expression.args;
  switch (expression.name) {
    case "not":
      return !truthy(evaluate(left, context, node));
    case "and": {
      const first = evaluate(left, context, node);
      return truthy(first) && truthy(evaluate(right, context, node));
    }
    case "or": {
      const first = evaluate(left, context, node);
      return truthy(first) || truthy(evaluate(right, context, node));
    }
    case "equals": {
      const first = evaluate(left, context, node);
      const second = evaluate(right, context, node);
      if (
        (first !== null && typeof first === "object") ||
        (second !== null && typeof second === "object")
      )
        throw new TemplateEvaluationError(
          "topik-expression-type",
          node,
          "equals accepts only scalar values",
        );
      return first === second;
    }
  }
}

/** Resolve into a new, writable document; the authored branches remain untouched. */
export function evaluateDocument(
  document: ContentDocument,
  context: Record<string, unknown>,
  registry: Registry = components,
): ContentDocument {
  const resolved = resolveDocument(document, context, registry, false);
  // Structural validity alone cannot prove Markdown representability: removing
  // variables can expose empty task items or ambiguous adjacent mark delimiters.
  try {
    writeDocument(resolved, registry);
  } catch {
    throw new ContentEvaluationError(
      "Evaluated content cannot be written without changing its meaning",
    );
  }
  return resolved;
}

/** @internal Allocate reader anchors on the authored clone before selecting branches. */
export function evaluateDocumentForRendering(
  document: ContentDocument,
  context: Record<string, unknown>,
  registry: Registry,
): ContentDocument {
  return resolveDocument(document, context, registry, true);
}

function resolveDocument(
  document: ContentDocument,
  context: Record<string, unknown>,
  registry: Registry,
  includeHeadingIds: boolean,
): ContentDocument {
  const errors = validateDocument(document, registry);
  if (errors.length)
    throw new ContentEvaluationError(errors.map((error) => error.message).join("; "));
  if (
    !dataValue(context) ||
    context === null ||
    typeof context !== "object" ||
    Array.isArray(context)
  )
    throw new ContentEvaluationError("Evaluation context must be a plain data object");
  const resolved = structuredClone(document);
  const index = indexDocument(resolved);
  if (includeHeadingIds)
    assignAnchorIds(index.entries.filter(({ node }) => isAnchorNode(node)).map(({ node }) => node));
  materializeReferences(resolved, index);
  let interpolatedLength = 0;
  type StringPlan = { parts: string[]; length: number };
  const strings = new WeakMap<object, Map<string, StringPlan>>();
  const stringLengths = new WeakMap<object, Map<string, number>>();

  function reserveString(target: object, key: string, plan: StringPlan): void {
    const fields = strings.get(target) ?? new Map<string, StringPlan>();
    fields.set(key, plan);
    strings.set(target, fields);
    const lengths = stringLengths.get(target) ?? new Map<string, number>();
    lengths.set(key, plan.length);
    stringLengths.set(target, lengths);
    // Preserve empty/nonempty structure during branch selection and cleanup.
    // Real strings are allocated only after the complete derived data fits.
    (target as Record<string, unknown>)[key] = plan.length ? "x" : "";
  }

  function resolveTemplate(template: TextTemplate, node: TreeNode, attribute?: string): StringPlan {
    const parts: string[] = [];
    let length = 0;
    for (const segment of template.segments) {
      let text: string;
      if (segment.type === "literal") text = segment.value;
      else {
        const variable = variableLabel(segment.path);
        const value = lookup(context, segment.path, (kind) => {
          throw new TemplateEvaluationError(
            kind === "path" ? "topik-variable-path" : `topik-template-variable-${kind}`,
            node,
            "Template variable lookup failed",
            attribute,
            variable,
          );
        });
        if (
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        )
          throw new TemplateEvaluationError(
            "topik-template-variable-type",
            node,
            "Template variables require scalar values",
            attribute,
            variable,
          );
        text = value === null ? "" : String(value);
        if (hasControlCharacters(text))
          throw new TemplateEvaluationError(
            "topik-template-control",
            node,
            "Template variable values must be single-line without controls",
            attribute,
            variable,
          );
        // Count each occurrence before appending, including repeated references.
        interpolatedLength += text.length;
        if (interpolatedLength > CONTENT_LIMITS.dataStringLength)
          throw new TemplateEvaluationError(
            "topik-content-limit",
            node,
            "Interpolated content exceeds the data string limit",
          );
      }
      length += text.length;
      if (length > CONTENT_LIMITS.dataStringLength)
        throw new TemplateEvaluationError(
          "topik-content-limit",
          node,
          "Resolved template exceeds the data string limit",
        );
      parts.push(text);
    }
    return { parts, length };
  }

  let emptyFootnote: (node: TreeNode) => boolean = () => false;
  function resolveChildren(children: TreeNode[]): TreeNode[] {
    const result: TreeNode[] = [];
    function append(node: TreeNode): void {
      const previous = result.at(-1);
      if (previous?.type === "text" && node.type === "text") {
        const before = strings.get(previous)?.get("value") ?? {
          parts: [previous.value ?? ""],
          length: previous.value?.length ?? 0,
        };
        const after = strings.get(node)?.get("value") ?? {
          parts: [node.value ?? ""],
          length: node.value?.length ?? 0,
        };
        for (const part of after.parts) before.parts.push(part);
        before.length += after.length;
        reserveString(previous, "value", before);
        delete previous.position;
      } else result.push(node);
    }
    for (const original of children) {
      if (original.type === "footnoteDefinition" || emptyFootnote(original)) {
        if (original.type === "footnoteDefinition") result.push(original);
        continue;
      }
      if (original.type === "topikConditional") {
        const [first, alternate] = original.children!;
        const selected = truthy(evaluate(first.condition as Expression, context, original))
          ? first
          : alternate;
        if (selected) for (const child of resolveChildren(selected.children ?? [])) append(child);
        continue;
      }
      if (original.type === "topikVariable") {
        const path = original.path as string[];
        const value = lookupAt(context, path, original);
        if (value !== null && typeof value === "object")
          throw new TemplateEvaluationError(
            "topik-variable-type",
            original,
            `Cannot interpolate object $${path.join(".")}`,
            undefined,
            variableLabel(path),
          );
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          const text = String(value);
          interpolatedLength += text.length;
          if (interpolatedLength > CONTENT_LIMITS.dataStringLength)
            throw new TemplateEvaluationError(
              "topik-content-limit",
              original,
              "Interpolated content exceeds the data string limit",
            );
          if (typeof value === "string" && hasControlCharacters(value))
            throw new TemplateEvaluationError(
              "topik-variable-control",
              original,
              "Interpolated text must be single-line without controls",
              undefined,
              variableLabel(path),
            );
          if (text) {
            const node = { type: "text", value: "" };
            reserveString(node, "value", { parts: [text], length: text.length });
            append(node);
          }
        }
        continue;
      }
      const node = original;
      if (node.type === "topikCodeTemplate") {
        reserveString(node, "value", resolveTemplate(node.template!, node));
        node.type = "code";
        delete node.template;
      }
      if (node.type === "topikComponent") {
        for (const [name, value] of Object.entries(node.props!))
          if (typeof value === "object")
            reserveString(node.props!, name, resolveTemplate(value, node, name));
      }
      if (node.children) node.children = resolveChildren(node.children);
      // Removing the final interpolation can expose a terminal break that the
      // authoring grammar cannot represent. Interior breaks remain meaningful.
      if (inlineParentTypes.has(node.type) && node.type !== "link" && node.type !== "linkReference")
        while (node.children?.at(-1)?.type === "break") node.children.pop();
      const definition = node.type === "topikComponent" ? registry[node.name!] : undefined;
      if (
        node.children?.length === 0 &&
        (node.type === "paragraph" ||
          node.type === "strong" ||
          node.type === "emphasis" ||
          node.type === "delete" ||
          (definition?.kind === "inline" && definition.children === "inline"))
      )
        continue;
      append(node);
    }
    return result;
  }

  // A footnote referenced only in hidden branches is not part of the evaluated content, so its
  // definition is dropped before its body is evaluated: data it needs may be absent. A footnote
  // whose body evaluates to nothing is dropped with its references, like an emptied paragraph.
  // Definitions are top level and cannot contain references or conditionals.
  function shownReferences(nodes: readonly TreeNode[], keys = new Set<string>()): Set<string> {
    for (const node of nodes) {
      if (node.type === "footnoteDefinition") continue;
      if (node.type === "footnoteReference") keys.add(footnoteKey(node));
      else if (node.type === "topikConditional") {
        const [first, alternate] = node.children!;
        const selected = truthy(evaluate(first.condition as Expression, context, node))
          ? first
          : alternate;
        shownReferences(selected?.children ?? [], keys);
      } else shownReferences(node.children ?? [], keys);
    }
    return keys;
  }
  const shown = shownReferences(resolved.children as TreeNode[]);
  for (const child of resolved.children as TreeNode[]) {
    if (child.type !== "footnoteDefinition" || !shown.has(footnoteKey(child))) continue;
    child.children = resolveChildren(child.children ?? []);
    if (!child.children.length) shown.delete(footnoteKey(child));
  }
  emptyFootnote = (node) => node.type === "footnoteReference" && !shown.has(footnoteKey(node));
  resolved.children = resolveChildren(
    (resolved.children as TreeNode[]).filter(
      (child) => child.type !== "footnoteDefinition" || shown.has(footnoteKey(child)),
    ),
  ) as ContentDocument["children"];
  try {
    assertDataLimits(resolved, { plain: true, stringLengths });
  } catch (error) {
    if (error instanceof ContentLimitError)
      throw new TemplateEvaluationError("topik-content-limit", resolved, error.message);
    throw error;
  }

  // Only retained data is materialized: text merging may leave plans for nodes
  // that are no longer in the result. Descriptor admission already ran above.
  function materialize(value: unknown, seen = new Set<object>()): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const plans = strings.get(value);
    if (plans)
      for (const [key, plan] of plans)
        (value as Record<string, unknown>)[key] = plan.parts.join("");
    for (const child of Object.values(value)) materialize(child, seen);
  }
  materialize(resolved);
  const resolvedErrors = validateDocument(resolved, registry);
  if (resolvedErrors.length) {
    // Interpolated values can still break a component rule, such as a blank video title:
    // report the rule's own diagnostic where it applies.
    const [first] = resolvedErrors;
    if (first.id === "topik-content-limit")
      throw new TemplateEvaluationError(
        "topik-content-limit",
        resolved,
        "Resolved content exceeds the data limits",
      );
    if (first.id !== undefined)
      throw new TemplateEvaluationError(
        first.id,
        {
          type: first.type ?? "document",
          ...(first.line === undefined
            ? {}
            : { position: { start: { line: first.line, column: first.column ?? 1 } } }),
        } as TreeNode,
        resolvedErrors.map((error) => error.message).join("; "),
        first.attribute,
      );
    throw new ContentEvaluationError(resolvedErrors.map((error) => error.message).join("; "));
  }
  return resolved;
}
