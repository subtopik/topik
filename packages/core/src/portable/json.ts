import { TOPIK_JSON_VERSION } from "./constants";

export class TopikJsonSyntaxError extends SyntaxError {
  constructor(
    message: string,
    public readonly offset: number,
    public readonly duplicatePointer?: string,
  ) {
    super(message);
    this.name = "TopikJsonSyntaxError";
  }
}

export function parseStrictTopikJson(source: string, maxDepth = 8): unknown {
  let offset = 0;

  function whitespace(): void {
    while (offset < source.length && isJsonWhitespace(source.charCodeAt(offset))) offset++;
  }

  function value(depth: number, pointer: string): unknown {
    if (depth > maxDepth) throw new TopikJsonSyntaxError("JSON exceeds maximum depth", offset);
    whitespace();
    const character = source[offset];
    if (character === "{") return object(depth, pointer);
    if (character === "[") return array(depth, pointer);
    if (character === '"') return string();
    if (source.startsWith("true", offset)) {
      offset += 4;
      return true;
    }
    if (source.startsWith("false", offset)) {
      offset += 5;
      return false;
    }
    if (source.startsWith("null", offset)) {
      offset += 4;
      return null;
    }
    if (character === "-" || (character >= "0" && character <= "9")) return number();
    throw new TopikJsonSyntaxError("Expected a JSON value", offset);
  }

  function object(depth: number, pointer: string): Record<string, unknown> {
    offset++;
    whitespace();
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (source[offset] === "}") {
      offset++;
      return result;
    }
    while (offset < source.length) {
      whitespace();
      if (source[offset] !== '"') throw new TopikJsonSyntaxError("Expected object member", offset);
      const key = string();
      const memberPointer = `${pointer}/${escapePointer(key)}`;
      if (keys.has(key)) {
        throw new TopikJsonSyntaxError("Duplicate JSON object member", offset, memberPointer);
      }
      keys.add(key);
      whitespace();
      if (source[offset] !== ":") throw new TopikJsonSyntaxError("Expected ':'", offset);
      offset++;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: value(depth + 1, memberPointer),
        writable: true,
      });
      whitespace();
      if (source[offset] === "}") {
        offset++;
        return result;
      }
      if (source[offset] !== ",") throw new TopikJsonSyntaxError("Expected ',' or '}'", offset);
      offset++;
    }
    throw new TopikJsonSyntaxError("Unterminated object", offset);
  }

  function array(depth: number, pointer: string): unknown[] {
    offset++;
    whitespace();
    const result: unknown[] = [];
    if (source[offset] === "]") {
      offset++;
      return result;
    }
    while (offset < source.length) {
      result.push(value(depth + 1, `${pointer}/${result.length}`));
      whitespace();
      if (source[offset] === "]") {
        offset++;
        return result;
      }
      if (source[offset] !== ",") throw new TopikJsonSyntaxError("Expected ',' or ']'", offset);
      offset++;
    }
    throw new TopikJsonSyntaxError("Unterminated array", offset);
  }

  function string(): string {
    const start = offset;
    offset++;
    while (offset < source.length) {
      const character = source.charCodeAt(offset);
      if (character === 0x22) {
        offset++;
        const parsed = JSON.parse(source.slice(start, offset)) as string;
        if (hasLoneSurrogate(parsed)) {
          throw new TopikJsonSyntaxError("Lone surrogate is not valid topik-json-v1", start);
        }
        return parsed;
      }
      if (character < 0x20) throw new TopikJsonSyntaxError("Control in JSON string", offset);
      if (character === 0x5c) {
        offset++;
        const escaped = source[offset];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(offset + 1, offset + 5))) {
            throw new TopikJsonSyntaxError("Invalid Unicode escape", offset);
          }
          offset += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped ?? "")) {
          throw new TopikJsonSyntaxError("Invalid string escape", offset);
        }
      }
      offset++;
    }
    throw new TopikJsonSyntaxError("Unterminated string", start);
  }

  function number(): number {
    const start = offset;
    while (offset < source.length && /[-+0-9.eE]/u.test(source[offset])) offset++;
    const spelling = source.slice(start, offset);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(spelling)) {
      throw new TopikJsonSyntaxError(
        "topik-json-v1 permits only ordinary nonnegative integers",
        start,
      );
    }
    const parsed = Number(spelling);
    if (!Number.isSafeInteger(parsed)) {
      throw new TopikJsonSyntaxError("JSON integer exceeds the safe integer range", start);
    }
    return parsed;
  }

  whitespace();
  const parsed = value(1, "");
  whitespace();
  if (offset !== source.length)
    throw new TopikJsonSyntaxError("Trailing data after JSON value", offset);
  return parsed;
}

/** RFC 8785 scalar/member rules with Topik's two-space layout and final LF. */
export function serializeTopikJson(value: unknown): string {
  assertSerializable(value);
  return `${pretty(value, 0)}\n`;
}

/** True only for values whose complete own-property graph is topik-json-v1 data. */
export function isTopikJsonDataValue(value: unknown): boolean {
  try {
    assertSerializable(value);
    return true;
  } catch {
    return false;
  }
}

export function topikJsonDescriptor(): { id: typeof TOPIK_JSON_VERSION } {
  return { id: TOPIK_JSON_VERSION };
}

function pretty(value: unknown, depth: number): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indent = "  ".repeat(depth + 1);
    return `[\n${value.map((entry) => `${indent}${pretty(entry, depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(compareUtf16);
  if (keys.length === 0) return "{}";
  const indent = "  ".repeat(depth + 1);
  return `{\n${keys
    .map((key) => `${indent}${JSON.stringify(key)}: ${pretty(object[key], depth + 1)}`)
    .join(",\n")}\n${"  ".repeat(depth)}}`;
}

function assertSerializable(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new TypeError("topik-json-v1 rejects lone surrogates");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError("topik-json-v1 permits only nonnegative safe integers");
    }
    return;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("Value is not serializable by topik-json-v1");
  }
  if (seen.has(value)) throw new TypeError("Cyclic value is not serializable");
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("topik-json-v1 rejects nonstandard array prototypes");
    }
    const names = Object.getOwnPropertyNames(value);
    const symbols = Object.getOwnPropertySymbols(value);
    if (
      symbols.length !== 0 ||
      names.length !== value.length + 1 ||
      names.some((name) => name !== "length" && !isArrayIndex(name, value.length))
    ) {
      throw new TypeError("topik-json-v1 requires dense arrays without extra properties");
    }
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("topik-json-v1 requires own array data properties");
      }
      assertSerializable(descriptor.value, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("topik-json-v1 rejects inherited or custom object prototypes");
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError("topik-json-v1 rejects symbol properties");
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        hasLoneSurrogate(key) ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.value === undefined
      ) {
        throw new TypeError(
          "topik-json-v1 requires enumerable own data properties with defined values",
        );
      }
      assertSerializable(descriptor.value, seen);
    }
  }
  seen.delete(value);
}

function isArrayIndex(value: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20;
}
