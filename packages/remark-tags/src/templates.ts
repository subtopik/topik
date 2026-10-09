import { TAG_LIMITS, type TagTextTemplate } from "./types.js";

const pathSource = "[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*";
const token = new RegExp(`^\\{%[ \\t]*\\$(${pathSource})[ \\t]*%\\}$`);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly id = "topik-template-syntax",
  ) {
    super(message);
    this.name = "TemplateSyntaxError";
  }
}

function validPath(path: unknown): path is string[] {
  return (
    plainArray(path) &&
    path.length > 0 &&
    path.every((part) => typeof part === "string" && identifier.test(part) && !unsafeKeys.has(part))
  );
}

function literalProblem(value: string, code: boolean): boolean {
  if (code) return value.includes("\0") || value.includes("\r");
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 32 || unit === 127) return true;
  }
  return false;
}

function plainArray(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > TAG_LIMITS.treeNodes
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

/** Decode only the doubled-percent opener; emitted text never enters the scanner again. */
export function parseTextTemplate(source: string, code = false): TagTextTemplate {
  if (source.length > TAG_LIMITS.templateLength)
    throw new TemplateSyntaxError("Template exceeds the text length limit", "tag-content-limit");
  const segments: TagTextTemplate["segments"] = [];
  const literal: string[] = [];
  let index = 0;
  function append(segment: TagTextTemplate["segments"][number]): void {
    if (segments.length >= TAG_LIMITS.treeNodes)
      throw new TemplateSyntaxError(
        "Template exceeds the tag tree node limit",
        "tag-content-limit",
      );
    segments.push(segment);
  }
  function flush(): void {
    const value = literal.join("");
    literal.length = 0;
    if (literalProblem(value, code))
      throw new TemplateSyntaxError("Invalid literal template text", "topik-template-control");
    if (value) append({ type: "literal", value });
  }
  while (index < source.length) {
    const opener = source.indexOf("{%", index);
    if (opener < 0) {
      literal.push(source.slice(index));
      break;
    }
    literal.push(source.slice(index, opener));
    if (source[opener + 2] === "%") {
      literal.push("{%");
      index = opener + 3;
      continue;
    }
    const end = source.indexOf("%}", opener + 2);
    if (end < 0) throw new TemplateSyntaxError("Unterminated variable token in template");
    const match = token.exec(source.slice(opener, end + 2));
    if (!match) throw new TemplateSyntaxError("Templates support only {% $path %} variable tokens");
    const path = match[1].split(".");
    if (!validPath(path))
      throw new TemplateSyntaxError("Unsafe variable path in template", "topik-variable-path");
    flush();
    append({ type: "variable", path });
    index = end + 2;
  }
  flush();
  return { type: "topikTextTemplate", segments };
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && descriptor.enumerable && "value" in descriptor;
  });
}

/** Normalize complete literal runs before escaping, including caller-constructed segments. */
export function writeTextTemplate(template: unknown, code = false): string {
  if (
    !plain(template) ||
    template.type !== "topikTextTemplate" ||
    !plainArray(template.segments) ||
    Object.keys(template).some((key) => key !== "type" && key !== "segments")
  )
    throw new Error("Invalid text template");
  if (template.segments.length > TAG_LIMITS.treeNodes)
    throw new Error("Template exceeds the tag tree node limit");
  const result: string[] = [];
  const literal: string[] = [];
  const seen = new Set<object>();
  let outputLength = 0;
  let previousLiteralUnit = "";
  function charge(length: number): void {
    outputLength += length;
    if (outputLength > TAG_LIMITS.templateLength)
      throw new Error("Template exceeds the text length limit");
  }
  // Check the entire encoded payload before joining literal runs or replacing openers.
  for (const segment of template.segments) {
    if (!plain(segment) || seen.has(segment)) throw new Error("Invalid or shared template segment");
    seen.add(segment);
    if (
      segment.type === "literal" &&
      typeof segment.value === "string" &&
      Object.keys(segment).every((key) => key === "type" || key === "value")
    ) {
      if (literalProblem(segment.value, code)) throw new Error("Invalid literal template text");
      charge(segment.value.length);
      if (previousLiteralUnit === "{" && segment.value.startsWith("%")) charge(1);
      let index = segment.value.indexOf("{%");
      while (index >= 0) {
        charge(1);
        index = segment.value.indexOf("{%", index + 2);
      }
      if (segment.value) previousLiteralUnit = segment.value.at(-1)!;
    } else if (
      segment.type === "variable" &&
      validPath(segment.path) &&
      Object.keys(segment).every((key) => key === "type" || key === "path")
    ) {
      if (seen.has(segment.path)) throw new Error("Shared template variable path");
      seen.add(segment.path);
      charge(7 + segment.path.length - 1);
      for (const part of segment.path) charge(part.length);
      previousLiteralUnit = "";
    } else throw new Error("Invalid text template segment or variable path");
  }
  function flush(): void {
    const value = literal.join("");
    literal.length = 0;
    if (literalProblem(value, code)) throw new Error("Invalid literal template text");
    result.push(value.replaceAll("{%", "{%%"));
  }
  for (const segment of template.segments) {
    const checked = segment as TagTextTemplate["segments"][number];
    if (checked.type === "literal") {
      literal.push(checked.value);
    } else {
      flush();
      result.push(`{% $${checked.path.join(".")} %}`);
    }
  }
  flush();
  return result.join("");
}
