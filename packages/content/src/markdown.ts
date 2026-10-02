import type { ParseResult } from "./model.js";
import { components, type Registry } from "./registry.js";
import { FORMAT_VERSION, parseDocumentTree } from "./parser.js";
import { writeDocument } from "./writer.js";

export {
  FORMAT_VERSION,
  parseDocumentTree,
  convertTags,
  type DocumentTreeResult,
} from "./parser.js";
export { writeDocument } from "./writer.js";

export function parseDocument(
  source: string,
  registry: Registry = components,
  formatVersion = FORMAT_VERSION,
): ParseResult {
  const result = parseDocumentTree(source, registry, formatVersion);
  return result.document && result.diagnostics.length === 0
    ? { ok: true, document: result.document, source }
    : { ok: false, diagnostics: result.diagnostics, source };
}

export function formatDocument(
  source: string,
  registry: Registry = components,
): ParseResult & { formatted?: string } {
  const result = parseDocument(source, registry);
  if (!result.ok) return result;
  try {
    return { ...result, formatted: writeDocument(result.document, registry) };
  } catch {
    return {
      ok: false,
      source,
      diagnostics: [
        { id: "topik-write-failed", message: "Content could not be serialized faithfully" },
      ],
    };
  }
}
