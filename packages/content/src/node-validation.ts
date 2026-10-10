import type { TreeNode } from "./model.js";
import type { Registry, ValidationIssue } from "./registry.js";
import { validPath } from "./expressions.js";
import { CONTENT_LIMITS } from "./limits.js";

import {
  parentTypes as parents,
  inlineParentTypes as inlineParents,
  isContentKind,
} from "./node-grammar.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): value is string {
  return typeof value === "string" && !/[\0\r]/.test(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || string(value);
}

function dense(array: unknown[]): boolean {
  const keys = Object.keys(array);
  return keys.length === array.length && keys.every((key, index) => key === String(index));
}

function controls(value: string, allowTab = false, includeSpace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if ((unit < (includeSpace ? 33 : 32) && !(allowTab && unit === 9)) || unit === 127) return true;
  }
  return false;
}

/** Admission runs after descriptor-based plain-data checks, before cloning or callbacks. */
export function textTemplateProblem(
  value: unknown,
  code = false,
  seen = new Set<object>(),
): ValidationIssue | undefined {
  const invalid = (message: string): ValidationIssue => ({ id: "topik-template-syntax", message });
  if (
    !record(value) ||
    value.type !== "topikTextTemplate" ||
    Object.keys(value).some((key) => key !== "type" && key !== "segments") ||
    !Array.isArray(value.segments) ||
    !dense(value.segments)
  )
    return invalid("Templates require a discriminator and an array of segments");
  const claim = (object: object): boolean => {
    if (seen.has(object)) return false;
    seen.add(object);
    return true;
  };
  if (!claim(value) || !claim(value.segments))
    return invalid("Template data must not be shared between authoring positions");
  for (const segment of value.segments) {
    if (!record(segment) || !claim(segment))
      return invalid("Templates require independent plain-data segment objects");
    if (segment.type === "literal") {
      if (
        Object.keys(segment).some((key) => key !== "type" && key !== "value") ||
        typeof segment.value !== "string"
      )
        return invalid("Literal template segments require a string value");
      if (code ? /[\0\r]/.test(segment.value) : controls(segment.value))
        return {
          id: "topik-template-control",
          message: code
            ? "Code template literals cannot contain NUL or carriage returns"
            : "Attribute template literals must be single-line without controls",
        };
    } else if (segment.type === "variable") {
      if (Object.keys(segment).some((key) => key !== "type" && key !== "path"))
        return invalid("Variable template segments require only a path");
      if (Array.isArray(segment.path) && segment.path.length > CONTENT_LIMITS.treeNodes)
        return { id: "topik-content-limit", message: "Template path exceeds the item limit" };
      if (!Array.isArray(segment.path) || !dense(segment.path) || !validPath(segment.path))
        return { id: "topik-variable-path", message: "Invalid template variable path" };
      if (!claim(segment.path))
        return invalid("Template paths must not be shared between authoring positions");
    } else return invalid("Unsupported template segment discriminator");
  }
}

export function codeTemplateProblem(
  node: TreeNode,
  seen = new Set<object>(),
): ValidationIssue | undefined {
  if (
    Object.keys(node).some(
      (key) => !["type", "lang", "meta", "template", "position", "data"].includes(key),
    )
  )
    return {
      id: "topik-code-template-structure",
      message: "Code templates have one authoritative template payload",
    };
  if (
    !optionalString(node.lang) ||
    !optionalString(node.meta) ||
    node.lang === "" ||
    node.meta === "" ||
    (node.meta != null && !node.lang) ||
    (typeof node.lang === "string" && controls(node.lang, false, true)) ||
    (typeof node.meta === "string" && controls(node.meta, true))
  )
    return {
      id: "topik-code-template-structure",
      message: "Code template language and metadata must fit one fence header",
    };
  if (node.lang === "mermaid")
    return {
      id: "topik-code-template-language",
      message: "Code templates require a text code renderer",
    };
  return textTemplateProblem(node.template, true, seen);
}

/** Validate mdast fields and grammar before callbacks, cloning, or serialization. */
export function nodeShapeProblem(value: unknown, registry: Registry): string | undefined {
  if (!record(value) || typeof value.type !== "string")
    return "Content nodes must have a string type";
  const node = value;
  const type = node.type as string;
  const children = node.children;
  if (node.position !== undefined) {
    const position = node.position;
    if (
      !record(position) ||
      [position.start, position.end].some(
        (point) =>
          !record(point) ||
          !Number.isInteger(point.line) ||
          (point.line as number) < 1 ||
          !Number.isInteger(point.column) ||
          (point.column as number) < 1 ||
          (point.offset !== undefined &&
            (!Number.isInteger(point.offset) || (point.offset as number) < 0)),
      )
    )
      return "Content positions require valid start and end points";
  }
  if (node.data !== undefined && !record(node.data)) return "Content metadata must be an object";
  if (parents.has(type)) {
    if (
      !Array.isArray(children) ||
      children.some((child) => !record(child) || typeof child.type !== "string")
    )
      return `${type} requires an array of content nodes`;
  } else if (children !== undefined) return `${type} cannot contain children`;

  const nodes = (children ?? []) as TreeNode[];
  if (type === "root" || type === "blockquote" || type === "listItem") {
    if (
      nodes.some(
        (child) =>
          !(type === "root" && child.type === "yaml") && !isContentKind(child, "block", registry),
      )
    )
      return `${type} requires block children`;
  }
  if (inlineParents.has(type) && nodes.some((child) => !isContentKind(child, "inline", registry)))
    return `${type} requires inline children`;
  if (
    inlineParents.has(type) &&
    type !== "link" &&
    type !== "linkReference" &&
    nodes.at(-1)?.type === "break"
  )
    return "A trailing hard break has no faithful Markdown representation";

  switch (type) {
    case "text":
      if (!string(node.value) || !node.value)
        return "Text requires nonempty content without NUL or carriage returns";
      break;
    case "yaml":
    case "code":
      if (!string(node.value))
        return `${type} requires a string value without NUL or carriage returns`;
      if (type === "yaml" && /^---[ \t]*$/m.test(node.value))
        return "Frontmatter content cannot contain its closing fence";
      if (
        type === "code" &&
        (!optionalString(node.lang) ||
          !optionalString(node.meta) ||
          (node.meta != null && !node.lang))
      )
        return "Code language and metadata must fit one fence header";
      break;
    case "inlineCode":
      if (!string(node.value) || !node.value || node.value.includes("\n"))
        return "Inline code requires nonempty single-line content";
      break;
    case "heading":
      if (!Number.isInteger(node.depth) || (node.depth as number) < 1 || (node.depth as number) > 6)
        return "Heading depth must be an integer from 1 to 6";
      if (
        record(node.data) &&
        node.data.topikId !== undefined &&
        (typeof node.data.topikId !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(node.data.topikId))
      )
        return "Explicit heading IDs must contain supported characters";
      break;
    case "emphasis":
    case "strong":
    case "delete":
      if (!nodes.length) return `${type} requires inline children`;
      break;
    case "list":
      if (!nodes.length || nodes.some((child) => child.type !== "listItem"))
        return "Lists require list item children";
      if (node.ordered != null && typeof node.ordered !== "boolean")
        return "List ordered must be a boolean";
      if (
        node.start != null &&
        (!node.ordered ||
          !Number.isInteger(node.start) ||
          (node.start as number) < 0 ||
          (node.start as number) > 999_999_999)
      )
        return "Ordered list start must be an integer from 0 to 999999999";
      if (node.spread != null && typeof node.spread !== "boolean")
        return "List spread must be a boolean";
      break;
    case "listItem":
      if (node.checked != null && typeof node.checked !== "boolean")
        return "List item checked must be a boolean";
      if (node.spread != null && typeof node.spread !== "boolean")
        return "List item spread must be a boolean";
      break;
    case "table": {
      if (
        !nodes.length ||
        nodes.some((child) => child.type !== "tableRow" || !Array.isArray(child.children))
      )
        return "Tables require table row children";
      const width = nodes[0].children!.length;
      if (!width) return "Table headers must have at least one column";
      if (nodes.some((row) => row.children!.length !== width))
        return "Table rows must match the header column count";
      if (
        node.align != null &&
        (!Array.isArray(node.align) ||
          node.align.length !== width ||
          node.align.some(
            (align) => align !== null && !["left", "right", "center"].includes(align),
          ))
      )
        return "Table alignment must match its columns";
      break;
    }
    case "tableRow":
      if (!nodes.length || nodes.some((child) => child.type !== "tableCell"))
        return "Table rows require table cells";
      break;
    case "image":
    case "link":
    case "definition":
      if (!string(node.url) || !optionalString(node.title))
        return "Resources require a string URL and an optional string title";
      if (type === "image" && !optionalString(node.alt)) return "Image alt text must be a string";
      break;
    case "imageReference":
      if (!optionalString(node.alt)) return "Image alt text must be a string";
      break;
    case "topikComponent":
      if (typeof node.name !== "string") return "Components require a string name";
      break;
  }
  if (type === "definition" || type === "imageReference" || type === "linkReference") {
    if (!string(node.identifier) || !node.identifier.trim() || !optionalString(node.label))
      return "References require a nonempty identifier and optional string label";
    if (
      type !== "definition" &&
      !["shortcut", "collapsed", "full"].includes(node.referenceType as string)
    )
      return "References require a supported reference type";
  }
}
