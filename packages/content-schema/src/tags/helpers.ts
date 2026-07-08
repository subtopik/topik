import type { Node, Schema, ValidationError } from "@markdoc/markdoc";

export const FLOW_CHILDREN = [
  "blockquote",
  "code",
  "em",
  "fence",
  "hardbreak",
  "heading",
  "hr",
  "image",
  "link",
  "list",
  "paragraph",
  "s",
  "softbreak",
  "strong",
  "table",
  "tag",
  "text",
] as const;

export const INLINE_CHILDREN = [
  "em",
  "hardbreak",
  "link",
  "s",
  "softbreak",
  "strong",
  "tag",
  "text",
] as const;

export function error(id: string, message: string): ValidationError {
  return { id, level: "error", message };
}

export function invalidChildError(
  parent: string,
  child: Node,
  allowed: readonly string[],
): ValidationError {
  const childName = tagName(child) ?? child.type;
  return error(
    `topik-${kebab(parent)}-children`,
    `'${parent}' only accepts ${joinAllowed(allowed)} children. Found '${childName}'.`,
  );
}

export function directTagChildren(node: Node, tag: string): Node[] {
  return structuralChildren(node).filter((child) => child.type === "tag" && child.tag === tag);
}

export function directChildrenOfType(node: Node, type: string): Node[] {
  return structuralChildren(node).filter((child) => child.type === type);
}

export function validateOnlyDirectTagChildren(parent: string, allowed: readonly string[]) {
  return (node: Node): ValidationError[] => {
    const errors: ValidationError[] = [];
    for (const child of structuralChildren(node)) {
      if (child.type === "tag" && child.tag && allowed.includes(child.tag)) continue;
      if (isIgnorableTextContainer(child)) continue;
      errors.push(invalidChildError(parent, child, allowed));
    }
    return errors;
  };
}

export function validateRequiredDirectChild(parent: string, required: string) {
  return (node: Node): ValidationError[] => {
    if (directChildrenOfType(node, required).length > 0) return [];
    return [
      error(
        `topik-${kebab(parent)}-requires-${kebab(required)}`,
        `'${parent}' requires at least one '${required}' child.`,
      ),
    ];
  };
}

export function validateRequiredDirectTagChild(parent: string, required: string) {
  return (node: Node): ValidationError[] => {
    if (directTagChildren(node, required).length > 0) return [];
    return [
      error(
        `topik-${kebab(parent)}-requires-${kebab(required)}`,
        `'${parent}' requires at least one '${required}' child.`,
      ),
    ];
  };
}

export function composeValidators(...validators: Array<NonNullable<Schema["validate"]>>) {
  return (
    node: Node,
    config: Parameters<NonNullable<Schema["validate"]>>[1],
  ): ValidationError[] => {
    const errors: ValidationError[] = [];
    for (const validate of validators) {
      const result = validate(node, config);
      if (Array.isArray(result)) errors.push(...result);
    }
    return errors;
  };
}

export function validateParentTag(tag: string) {
  return (
    _node: Node,
    config: Parameters<NonNullable<Schema["validate"]>>[1],
  ): ValidationError[] => {
    const parents = config.validation?.parents ?? [];
    if (parents.some((parent) => parent.type === "tag" && parent.tag === tag)) return [];
    return [
      error(`topik-${kebab(tag)}-parent-required`, `This tag must be nested inside '${tag}'.`),
    ];
  };
}

export function validateNumericRange(attribute: string, min: number, max: number) {
  return (value: unknown): ValidationError[] => {
    if (typeof value !== "number") return [];
    if (Number.isInteger(value) && value >= min && value <= max) return [];
    return [
      error(
        `topik-${kebab(attribute)}-range`,
        `Attribute '${attribute}' must be an integer from ${min} to ${max}.`,
      ),
    ];
  };
}

function tagName(node: Node): string | undefined {
  return node.type === "tag" ? node.tag : undefined;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function joinAllowed(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(" or ");
}

function isIgnorableTextContainer(node: Node): boolean {
  if (node.type !== "paragraph") return false;
  return node.children.every(
    (child) => child.type === "text" && String(child.attributes?.content ?? "").trim() === "",
  );
}

function structuralChildren(node: Node): Node[] {
  return node.children.flatMap((child) => unwrapStructuralContainer(child));
}

function unwrapStructuralContainer(node: Node): Node[] {
  if (node.type !== "paragraph" && node.type !== "inline") return [node];

  const nonWhitespace = node.children.filter(
    (child) => child.type !== "text" || String(child.attributes?.content ?? "").trim() !== "",
  );
  const withoutBreaks = nonWhitespace.filter(
    (child) => child.type !== "softbreak" && child.type !== "hardbreak",
  );

  if (withoutBreaks.length > 0 && withoutBreaks.every((child) => child.type === "tag")) {
    return withoutBreaks;
  }

  if (withoutBreaks.length === 1 && withoutBreaks[0].type === "inline") {
    return unwrapStructuralContainer(withoutBreaks[0]);
  }

  return [node];
}
