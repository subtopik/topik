import { CONTENT_LIMITS, ContentLimitError } from "./limits.js";

/** The deliberately small expression language accepted in authored conditionals. */
export type Expression =
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "variable"; path: string[] }
  | { type: "call"; name: "equals" | "and" | "or" | "not"; args: Expression[] };

const identifier = /^[A-Za-z_][A-Za-z0-9_]*/;
const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

export function validPath(path: string[]): boolean {
  return (
    Array.isArray(path) &&
    path.length > 0 &&
    path.every(
      (part) =>
        typeof part === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) && !unsafeKeys.has(part),
    )
  );
}

export function parseExpression(source: string): Expression {
  if (source.length > CONTENT_LIMITS.expressionLength)
    throw new ContentLimitError(
      `Content exceeds the expression length limit of ${CONTENT_LIMITS.expressionLength}`,
    );
  let index = 0;
  let nodes = 0;
  function fail(message: string): never {
    throw new Error(`${message} at expression offset ${index}`);
  }
  function space(): void {
    while (/\s/.test(source[index] ?? "")) index++;
  }
  function readIdentifier(): string {
    const match = identifier.exec(source.slice(index));
    if (!match) fail("Expected identifier");
    index += match[0].length;
    return match[0];
  }
  function expression(depth = 0): Expression {
    if (depth > CONTENT_LIMITS.expressionDepth)
      throw new ContentLimitError(
        `Content exceeds the expression depth limit of ${CONTENT_LIMITS.expressionDepth}`,
      );
    if (++nodes > CONTENT_LIMITS.expressionNodes)
      throw new ContentLimitError(
        `Content exceeds the expression node limit of ${CONTENT_LIMITS.expressionNodes}`,
      );
    space();
    const char = source[index];
    if (char === '"' || char === "'") {
      index++;
      let value = "";
      while (index < source.length) {
        const next = source[index++];
        if (next === char) return { type: "literal", value };
        if (next === "\\") {
          const escaped = source[index++];
          if (escaped === undefined) fail("Unterminated string escape");
          if (escaped === "n") value += "\n";
          else if (escaped === "r") value += "\r";
          else if (escaped === "t") value += "\t";
          else if (escaped === "b") value += "\b";
          else if (escaped === "f") value += "\f";
          else if (escaped === "u") {
            const digits = source.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail("Invalid Unicode escape");
            value += String.fromCharCode(Number.parseInt(digits, 16));
            index += 4;
          } else if (escaped === char || escaped === "\\") value += escaped;
          else fail("Unsupported string escape");
        } else value += next;
      }
      fail("Unterminated string");
    }
    if (char === "$") {
      index++;
      const path = [readIdentifier()];
      while (source[index] === ".") {
        index++;
        path.push(readIdentifier());
      }
      if (!validPath(path)) fail("Unsafe variable path");
      return { type: "variable", path };
    }
    const numeric = number.exec(source.slice(index));
    if (numeric) {
      index += numeric[0].length;
      const value = Number(numeric[0]);
      if (!Number.isFinite(value)) fail("Number must be finite");
      return { type: "literal", value };
    }
    const name = readIdentifier();
    if (name === "true" || name === "false" || name === "null")
      return { type: "literal", value: name === "null" ? null : name === "true" };
    if (name !== "equals" && name !== "and" && name !== "or" && name !== "not")
      fail(`Unknown expression function ${name}`);
    space();
    if (source[index++] !== "(") fail(`Expected ( after ${name}`);
    const args: Expression[] = [];
    space();
    if (source[index] !== ")") {
      while (true) {
        args.push(expression(depth + 1));
        space();
        if (source[index] !== ",") break;
        index++;
      }
    }
    if (source[index++] !== ")") fail(`Expected ) after ${name}`);
    if (args.length !== (name === "not" ? 1 : 2))
      fail(`${name} requires ${name === "not" ? 1 : 2} argument(s)`);
    return { type: "call", name, args };
  }
  const parsed = expression();
  space();
  if (index !== source.length) fail("Unexpected expression text");
  return parsed;
}

export function writeExpression(expression: Expression): string {
  const active = new Set<Expression>();
  let nodes = 0;
  function write(expression: Expression, depth = 0): string {
    if (active.has(expression)) throw new ContentLimitError("Expression contains a cycle");
    if (depth > CONTENT_LIMITS.expressionDepth)
      throw new ContentLimitError(
        `Content exceeds the expression depth limit of ${CONTENT_LIMITS.expressionDepth}`,
      );
    if (++nodes > CONTENT_LIMITS.expressionNodes)
      throw new ContentLimitError(
        `Content exceeds the expression node limit of ${CONTENT_LIMITS.expressionNodes}`,
      );
    active.add(expression);
    try {
      return writeNode(expression, depth);
    } finally {
      active.delete(expression);
    }
  }
  function writeNode(expression: Expression, depth: number): string {
    if (!expression || typeof expression !== "object") throw new Error("Invalid expression");
    if (expression.type === "literal") {
      const value = expression.value;
      if (value === null || typeof value === "boolean") return String(value);
      if (typeof value === "number" && Number.isFinite(value))
        return Object.is(value, -0) ? "-0" : String(value);
      if (typeof value === "string") return JSON.stringify(value);
      throw new Error("Invalid expression literal");
    }
    if (expression.type === "variable") {
      if (!validPath(expression.path)) throw new Error("Unsafe variable path");
      return `$${expression.path.join(".")}`;
    }
    if (
      expression.type !== "call" ||
      !["equals", "and", "or", "not"].includes(expression.name) ||
      !Array.isArray(expression.args) ||
      expression.args.length !== (expression.name === "not" ? 1 : 2)
    )
      throw new Error("Invalid expression call");
    return `${expression.name}(${expression.args.map((argument) => write(argument, depth + 1)).join(", ")})`;
  }
  const result = write(expression);
  if (result.length > CONTENT_LIMITS.expressionLength)
    throw new ContentLimitError(
      `Content exceeds the expression length limit of ${CONTENT_LIMITS.expressionLength}`,
    );
  return result;
}
