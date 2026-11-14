import type { TagAttributeValue, TagDeclarations, TagSyntaxOptions } from "./types.js";
import { parseTextTemplate } from "./templates.js";

export function validateDeclarations(
  declarations: TagDeclarations,
  options: TagSyntaxOptions = {},
): void {
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!/^[a-z][A-Za-z0-9-]*$/.test(name)) throw new Error(`Invalid tag declaration ${name}`);
    if (declaration?.kind !== "inline" && declaration?.kind !== "block")
      throw new Error(`Invalid kind for tag ${name}`);
    if (options.expressions && (name === "if" || name === "else"))
      throw new Error(`Reserved expression tag ${name}`);
  }
}

interface ParsedComponentTag {
  kind: "component";
  name: string;
  close: boolean;
  selfClosing: boolean;
  attributes: Record<string, TagAttributeValue>;
}
export type ParsedTag =
  | ParsedComponentTag
  | { kind: "variable"; path: string }
  | { kind: "codeTemplate"; close: boolean }
  | { kind: "if"; close: true }
  | { kind: "if"; close: false; expression: string }
  | { kind: "else" };

export function hasControlCharacter(value: string, escapedWhitespace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 32 || code === 127) && !(escapedWhitespace && [9, 10, 13].includes(code)))
      return true;
  }
  return false;
}

export function invalidCodeTemplateHeader(lang: unknown, meta: unknown): boolean {
  if (
    (lang != null &&
      (typeof lang !== "string" || !lang || hasControlCharacter(lang) || lang.includes(" "))) ||
    (meta != null && (typeof meta !== "string" || !meta || !lang))
  )
    return true;
  if (typeof meta === "string")
    for (let index = 0; index < meta.length; index++) {
      const unit = meta.charCodeAt(index);
      if ((unit < 32 && unit !== 9) || unit === 127) return true;
    }
  return false;
}

export const variablePath = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function validConditionSource(source: string): boolean {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\n" || char === "\r") return false;
    if (quote) {
      if (char === "\\" && !escaped) escaped = true;
      else {
        if (char === quote && !escaped) quote = "";
        escaped = false;
      }
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "%" && source[index + 1] === "}") return false;
  }
  return Boolean(source.trim()) && !quote;
}

/** A tag that cannot be parsed, with a stable diagnostic identifier. */
export interface TagParseFailure {
  kind: "error";
  id: string;
  message: string;
}

function failure(message: string, id: string): TagParseFailure {
  return { kind: "error", id, message };
}

export function parseTag(raw: string, options: TagSyntaxOptions): ParsedTag | TagParseFailure {
  if (!raw.startsWith("{%") || !raw.trimEnd().endsWith("%}"))
    return failure("Unterminated tag", "tag-unterminated");
  const inner = raw.trim().slice(2, -2).trim();
  if (options.expressions) {
    if (/^\/?template[ \t]+code$/.test(inner))
      return { kind: "codeTemplate", close: inner.startsWith("/") };
    if (/^\/?template[ \t]+code(?:[ \t]|\/|$)/.test(inner))
      return failure("Invalid code template scope marker", "topik-code-template-structure");
    if (inner.startsWith("$"))
      return variablePath.test(inner.slice(1))
        ? { kind: "variable", path: inner.slice(1) }
        : failure("Invalid variable path", "topik-variable-path");
    if (inner === "/if") return { kind: "if", close: true };
    if (/^else\s+\/$/.test(inner)) return { kind: "else" };
    if (/^else(?:\s|$)/.test(inner)) return failure("Unsupported else syntax", "topik-else-syntax");
    if (/^if(?:\s|$)/.test(inner)) {
      const expression = inner.slice(2).trim();
      return validConditionSource(expression)
        ? { kind: "if", close: false, expression }
        : failure("Invalid if expression source", "topik-expression-invalid");
    }
  }
  let index = 0;
  const close = inner.startsWith("/");
  if (close) index++;
  const nameMatch = /^[a-z][A-Za-z0-9-]*/.exec(inner.slice(index));
  if (!nameMatch) return failure("Invalid or unsupported tag", "tag-name-invalid");
  const name = nameMatch[0];
  index += name.length;
  const attributes: Record<string, TagAttributeValue> = Object.create(null);
  let selfClosing = false;
  while (index < inner.length) {
    if (!/\s/.test(inner[index]))
      return failure(`Invalid attributes on ${name}`, "attribute-syntax-invalid");
    while (/\s/.test(inner[index] ?? "")) index++;
    if (index === inner.length) break;
    if (inner[index] === "/" && index === inner.length - 1) {
      selfClosing = true;
      break;
    }
    const keyMatch = /^[a-z][A-Za-z0-9-]*/.exec(inner.slice(index));
    if (!keyMatch) return failure(`Invalid attribute on ${name}`, "attribute-syntax-invalid");
    const key = keyMatch[0];
    index += key.length;
    if (inner[index++] !== "=")
      return failure(`Attribute ${key} requires a value`, "attribute-syntax-invalid");
    let value: TagAttributeValue;
    const template = options.expressions && inner[index] === "t" && inner[index + 1] === '"';
    const escapedWhitespace =
      !template && options.escapedWhitespace?.[name]?.includes(key) === true;
    if (template) index++;
    if (inner[index] === '"') {
      index++;
      let literal = "";
      let ended = false;
      while (index < inner.length) {
        const char = inner[index++];
        if (!template && hasControlCharacter(char))
          return failure(`Control character in ${key}`, "attribute-value-invalid");
        if (char === '"') {
          ended = true;
          break;
        }
        if (char === "\\") {
          const escaped = inner[index++];
          if (escapedWhitespace && (escaped === "n" || escaped === "r" || escaped === "t")) {
            literal += escaped === "n" ? "\n" : escaped === "r" ? "\r" : "\t";
            continue;
          }
          if (
            escaped !== "\\" &&
            escaped !== '"' &&
            escaped !== "|" &&
            escaped !== "[" &&
            escaped !== "]"
          )
            return failure(`Invalid escape in ${key}`, "attribute-syntax-invalid");
          literal += escaped;
        } else literal += char;
      }
      if (!ended) return failure(`Unterminated attribute ${key}`, "attribute-syntax-invalid");
      if (!template && hasControlCharacter(literal, escapedWhitespace))
        return failure(`Control character in ${key}`, "attribute-value-invalid");
      value = template ? parseTextTemplate(literal) : literal;
    } else {
      const match = /^(?:true|false|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
        inner.slice(index),
      );
      if (!match)
        return failure(
          `Attribute ${key} must be quoted or a finite number/boolean`,
          "attribute-syntax-invalid",
        );
      index += match[0].length;
      value = match[0] === "true" ? true : match[0] === "false" ? false : Number(match[0]);
      if (typeof value === "number" && !Number.isFinite(value))
        return failure(`Attribute ${key} must be finite`, "attribute-syntax-invalid");
    }
    if (Object.hasOwn(attributes, key))
      return failure(`Duplicate attribute ${key}`, "duplicate-attribute");
    attributes[key] = value;
  }
  if (close && (selfClosing || Object.keys(attributes).length))
    return failure(`Invalid closing tag ${name}`, "tag-closing-invalid");
  return { kind: "component", name, close, selfClosing, attributes };
}
