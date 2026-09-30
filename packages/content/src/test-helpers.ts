import { parseDocument, type ContentDocument, type Registry } from "./index.js";

export function parse(source: string, registry?: Registry): ContentDocument {
  const result = parseDocument(source, registry);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.document;
}

/** Parser positions are source metadata, not authored document meaning. */
export function withoutPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPositions);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "position")
        .map(([key, item]) => [key, withoutPositions(item)]),
    );
  return value;
}
