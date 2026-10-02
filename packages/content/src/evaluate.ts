import type { ContentDocument, TreeNode } from "./model.js";
import type { Expression } from "./expressions.js";
import { validPath } from "./expressions.js";
import { components, type Registry } from "./registry.js";
import { validateDocument } from "./validation.js";
import { CONTENT_LIMITS } from "./limits.js";
import { indexDocument, materializeReferences } from "./document-index.js";
import { assignHeadingIds } from "./headings.js";
import type { Heading } from "mdast";
import { inlineParentTypes } from "./node-grammar.js";
import { writeDocument } from "./writer.js";

export class ContentEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentEvaluationError";
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

function lookup(context: Record<string, unknown>, path: string[]): unknown {
  if (!validPath(path)) throw new ContentEvaluationError("Unsafe variable path");
  let current: unknown = context;
  for (const part of path) {
    if (
      !dataValue(current) ||
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    )
      throw new ContentEvaluationError(`Cannot read $${path.join(".")}`);
    const descriptor = Object.getOwnPropertyDescriptor(current, part);
    if (!descriptor || !("value" in descriptor))
      throw new ContentEvaluationError(`Missing variable $${path.join(".")}`);
    current = descriptor.value;
  }
  if (!dataValue(current)) throw new ContentEvaluationError(`Non-data value $${path.join(".")}`);
  return current;
}

// Markdoc treats only false and null as false, including for the literal 0 and "".
function truthy(value: unknown): boolean {
  return value !== false && value !== null;
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function evaluate(expression: Expression, context: Record<string, unknown>): unknown {
  if (expression.type === "literal") return expression.value;
  if (expression.type === "variable") return lookup(context, expression.path);
  const [left, right] = expression.args;
  switch (expression.name) {
    case "not":
      return !truthy(evaluate(left, context));
    case "and": {
      const first = evaluate(left, context);
      return truthy(first) && truthy(evaluate(right, context));
    }
    case "or": {
      const first = evaluate(left, context);
      return truthy(first) || truthy(evaluate(right, context));
    }
    case "equals": {
      const first = evaluate(left, context);
      const second = evaluate(right, context);
      if (
        (first !== null && typeof first === "object") ||
        (second !== null && typeof second === "object")
      )
        throw new ContentEvaluationError("equals accepts only scalar values");
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
    assignHeadingIds(
      index.entries
        .filter(({ node }) => node.type === "heading")
        .map(({ node }) => node as Heading),
    );
  materializeReferences(resolved, index);
  let interpolatedLength = 0;

  function resolveChildren(children: TreeNode[]): TreeNode[] {
    const result: TreeNode[] = [];
    function append(node: TreeNode): void {
      const previous = result.at(-1);
      if (previous?.type === "text" && node.type === "text") {
        previous.value = (previous.value ?? "") + (node.value ?? "");
        delete previous.position;
      } else result.push(node);
    }
    for (const original of children) {
      if (original.type === "topikConditional") {
        const [first, alternate] = original.children!;
        const selected = truthy(evaluate(first.condition as Expression, context))
          ? first
          : alternate;
        if (selected) for (const child of resolveChildren(selected.children ?? [])) append(child);
        continue;
      }
      if (original.type === "topikVariable") {
        const value = lookup(context, original.path as string[]);
        if (value !== null && typeof value === "object")
          throw new ContentEvaluationError(
            `Cannot interpolate object $${(original.path as string[]).join(".")}`,
          );
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          const text = String(value);
          interpolatedLength += text.length;
          if (interpolatedLength > CONTENT_LIMITS.dataStringLength)
            throw new ContentEvaluationError("Interpolated content exceeds the data string limit");
          if (typeof value === "string" && hasControl(value))
            throw new ContentEvaluationError(
              "Interpolated text must be single-line without controls",
            );
          if (text) append({ type: "text", value: text });
        }
        continue;
      }
      const node = original;
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

  resolved.children = resolveChildren(
    resolved.children as TreeNode[],
  ) as ContentDocument["children"];
  const resolvedErrors = validateDocument(resolved, registry);
  if (resolvedErrors.length)
    throw new ContentEvaluationError(resolvedErrors.map((error) => error.message).join("; "));
  return resolved;
}
