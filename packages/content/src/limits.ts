import type { Diagnostic, TreeNode } from "./model.js";

/** Fixed admission limits, measured in UTF-16 code units and tree nodes. */
export const CONTENT_LIMITS = Object.freeze({
  sourceLength: 1_000_000,
  /** Inline delimiter attempts; code-span attempts are weighted by delimiter run length. */
  parserSteps: 4_096,
  treeDepth: 64,
  treeNodes: 50_000,
  dataDepth: 160,
  dataEntries: 500_000,
  dataStringLength: 1_000_000,
  expressionLength: 16_384,
  expressionDepth: 32,
  expressionNodes: 256,
  /** Bounded escaped payload and row decorations, before reader allocation. */
  presentationOutputLength: 8_000_000,
});

export class ContentLimitError extends Error {
  readonly id = "topik-content-limit";

  constructor(message: string) {
    super(message);
    this.name = "ContentLimitError";
  }
}

export class ContentDataError extends Error {
  readonly id = "topik-node-invalid";
}

export function limitDiagnostic(error: ContentLimitError): Diagnostic {
  return { id: error.id, message: error.message };
}

export function assertSourceLimit(source: string): void {
  if (source.length > CONTENT_LIMITS.sourceLength)
    throw new ContentLimitError(
      `Content exceeds the source length limit of ${CONTENT_LIMITS.sourceLength}`,
    );
}

/** Check before recursive transforms and return the number of admitted nodes. */
export function assertTreeLimits(root: TreeNode): number {
  const active = new Set<TreeNode>();
  const seen = new Set<TreeNode>();
  const stack = [{ node: root, depth: 0, exit: false }];
  let count = 0;
  while (stack.length) {
    const { node, depth, exit } = stack.pop()!;
    if (exit) {
      active.delete(node);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    if (active.has(node)) throw new ContentLimitError("Content tree contains a cycle");
    if (seen.has(node))
      throw new ContentDataError("Content nodes must not be shared between tree positions");
    seen.add(node);
    if (depth > CONTENT_LIMITS.treeDepth)
      throw new ContentLimitError(
        `Content exceeds the tree depth limit of ${CONTENT_LIMITS.treeDepth}`,
      );
    if (++count > CONTENT_LIMITS.treeNodes)
      throw new ContentLimitError(
        `Content exceeds the tree node limit of ${CONTENT_LIMITS.treeNodes}`,
      );
    const templates =
      (node.type === "topikCodeTemplate" || node.type === "tagCodeTemplate") && node.template
        ? [node.template]
        : [];
    const properties =
      node.type === "topikComponent"
        ? node.props
        : ["tagText", "tagLeaf", "tagContainer"].includes(node.type)
          ? node.attributes
          : undefined;
    for (const value of Object.values(properties ?? {}))
      if (value && typeof value === "object" && value.type === "topikTextTemplate")
        templates.push(value);
    for (const template of templates)
      count += 1 + (Array.isArray(template.segments) ? template.segments.length : 0);
    if (count > CONTENT_LIMITS.treeNodes)
      throw new ContentLimitError(
        `Content exceeds the tree node limit of ${CONTENT_LIMITS.treeNodes}`,
      );
    active.add(node);
    stack.push({ node, depth, exit: true });
    if (Array.isArray(node.children)) {
      if (node.children.length > CONTENT_LIMITS.treeNodes)
        throw new ContentLimitError(
          `Content exceeds the tree node limit of ${CONTENT_LIMITS.treeNodes}`,
        );
      for (let index = node.children.length - 1; index >= 0; index--)
        stack.push({ node: node.children[index], depth: depth + 1, exit: false });
    }
  }
  return count;
}

/** Include metadata and expressions so cloning cannot bypass the authoring-tree limits. */
export function assertDataLimits(
  root: unknown,
  options: {
    plain?: boolean;
    /** @internal Count deferred output strings before allocating their contents. */
    stringLengths?: WeakMap<object, ReadonlyMap<string, number>>;
  } = {},
): void {
  const active = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; exit: boolean; stringLength?: number }> = [
    { value: root, depth: 0, exit: false },
  ];
  let entries = 0;
  let strings = 0;
  while (stack.length) {
    const { value, depth, exit, stringLength } = stack.pop()!;
    if (exit) {
      active.delete(value as object);
      continue;
    }
    if (++entries > CONTENT_LIMITS.dataEntries)
      throw new ContentLimitError(
        `Content exceeds the data entry limit of ${CONTENT_LIMITS.dataEntries}`,
      );
    if (typeof value === "string") {
      strings += stringLength ?? value.length;
      if (strings > CONTENT_LIMITS.dataStringLength)
        throw new ContentLimitError(
          `Content exceeds the data string limit of ${CONTENT_LIMITS.dataStringLength}`,
        );
    }
    if (
      options.plain &&
      (typeof value === "function" ||
        typeof value === "symbol" ||
        typeof value === "bigint" ||
        (typeof value === "number" && !Number.isFinite(value)))
    )
      throw new ContentDataError("Content must contain plain data values");
    if (!value || typeof value !== "object") continue;
    if (options.plain) {
      const prototype = Object.getPrototypeOf(value);
      if (
        Array.isArray(value)
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        throw new ContentDataError("Content must contain plain objects and arrays");
    }
    if (active.has(value)) throw new ContentLimitError("Content data contains a cycle");
    if (depth > CONTENT_LIMITS.dataDepth)
      throw new ContentLimitError(
        `Content exceeds the data depth limit of ${CONTENT_LIMITS.dataDepth}`,
      );
    active.add(value);
    stack.push({ value, depth, exit: true });
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as string];
      if (
        options.plain &&
        (typeof key === "symbol" ||
          (!descriptor.enumerable && !(Array.isArray(value) && key === "length")))
      )
        throw new ContentDataError("Content properties must be enumerable string keys");
      // ASTs are plain data. Do not invoke accessors while inspecting caller input.
      if (!("value" in descriptor))
        throw new ContentDataError("Content data must not contain accessors");
      stack.push({
        value: descriptor.value,
        depth: depth + 1,
        exit: false,
        stringLength: options.stringLengths?.get(value)?.get(key as string),
      });
    }
  }
}
