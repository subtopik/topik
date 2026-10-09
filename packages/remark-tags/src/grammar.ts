import type { TagAttributeValue, TagDeclarations, TagSyntaxOptions } from "./types.js";
import { parseTextTemplate, TemplateSyntaxError } from "./templates.js";

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

export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
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

export function parseTag(raw: string, options: TagSyntaxOptions): ParsedTag | string {
  if (!raw.startsWith("{%") || !raw.trimEnd().endsWith("%}")) return "Unterminated tag";
  const inner = raw.trim().slice(2, -2).trim();
  if (options.expressions) {
    if (/^\/?template[ \t]+code$/.test(inner))
      return { kind: "codeTemplate", close: inner.startsWith("/") };
    if (/^\/?template[ \t]+code(?:[ \t]|\/|$)/.test(inner))
      throw new TemplateSyntaxError(
        "Invalid code template scope marker",
        "topik-code-template-structure",
      );
    if (inner.startsWith("$"))
      return variablePath.test(inner.slice(1))
        ? { kind: "variable", path: inner.slice(1) }
        : "Invalid variable path";
    if (inner === "/if") return { kind: "if", close: true };
    if (/^else\s+\/$/.test(inner)) return { kind: "else" };
    if (/^else(?:\s|$)/.test(inner)) return "Unsupported else syntax";
    if (/^if(?:\s|$)/.test(inner)) {
      const expression = inner.slice(2).trim();
      return validConditionSource(expression)
        ? { kind: "if", close: false, expression }
        : "Invalid if expression source";
    }
  }
  let index = 0;
  const close = inner.startsWith("/");
  if (close) index++;
  const nameMatch = /^[a-z][A-Za-z0-9-]*/.exec(inner.slice(index));
  if (!nameMatch) return "Invalid or unsupported tag";
  const name = nameMatch[0];
  index += name.length;
  const attributes: Record<string, TagAttributeValue> = Object.create(null);
  let selfClosing = false;
  while (index < inner.length) {
    if (!/\s/.test(inner[index])) return `Invalid attributes on ${name}`;
    while (/\s/.test(inner[index] ?? "")) index++;
    if (index === inner.length) break;
    if (inner[index] === "/" && index === inner.length - 1) {
      selfClosing = true;
      break;
    }
    const keyMatch = /^[a-z][A-Za-z0-9-]*/.exec(inner.slice(index));
    if (!keyMatch) return `Invalid attribute on ${name}`;
    const key = keyMatch[0];
    index += key.length;
    if (inner[index++] !== "=") return `Attribute ${key} requires a value`;
    let value: TagAttributeValue;
    const template = options.expressions && inner[index] === "t" && inner[index + 1] === '"';
    if (template) index++;
    if (inner[index] === '"') {
      index++;
      let literal = "";
      let ended = false;
      while (index < inner.length) {
        const char = inner[index++];
        if (char === '"') {
          ended = true;
          break;
        }
        if (char === "\\") {
          const escaped = inner[index++];
          if (
            escaped !== "\\" &&
            escaped !== '"' &&
            escaped !== "|" &&
            escaped !== "[" &&
            escaped !== "]"
          )
            return `Invalid escape in ${key}`;
          literal += escaped;
        } else literal += char;
      }
      if (!ended) return `Unterminated attribute ${key}`;
      if (!template && hasControlCharacter(literal)) return `Control character in ${key}`;
      value = template ? parseTextTemplate(literal) : literal;
    } else {
      const match = /^(?:true|false|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
        inner.slice(index),
      );
      if (!match) return `Attribute ${key} must be quoted or a finite number/boolean`;
      index += match[0].length;
      value = match[0] === "true" ? true : match[0] === "false" ? false : Number(match[0]);
      if (typeof value === "number" && !Number.isFinite(value))
        return `Attribute ${key} must be finite`;
    }
    if (Object.hasOwn(attributes, key)) return `Duplicate attribute ${key}`;
    attributes[key] = value;
  }
  if (close && (selfClosing || Object.keys(attributes).length))
    return `Invalid closing tag ${name}`;
  return { kind: "component", name, close, selfClosing, attributes };
}
