import { serializeDocument } from "./writer.js";
import { sameDocumentMeaning } from "./document-meaning.js";
import { prepareSource, writeFailure } from "./source.js";
import type { TopikContentDiagnostic } from "./diagnostics";
import { type ValidateTopikContentOptions } from "./validate";

export interface FormatTopikContentOptions extends ValidateTopikContentOptions {}

export interface FormatTopikContentSuccess {
  ok: true;
  /** Exact caller-supplied source. */
  source: string;
  diagnostics: TopikContentDiagnostic[];
  formatted: string;
}

export interface FormatTopikContentFailure {
  ok: false;
  /** Exact caller-supplied source, unchanged and unformatted. */
  source: string;
  diagnostics: TopikContentDiagnostic[];
}

export type FormatTopikContentResult = FormatTopikContentSuccess | FormatTopikContentFailure;

/** Validate source before formatting so unsupported input remains an exact opaque handoff. */
export function formatTopikContent(
  source: string,
  options: FormatTopikContentOptions = {},
): FormatTopikContentResult {
  const prepared = prepareSource(source, options);
  if (!prepared.ok) return prepared;
  let formatted: string;
  try {
    formatted = serializeDocument(prepared.document, prepared.config.components);
  } catch {
    return writeFailure(source, options.file);
  }
  const output = prepareSource(formatted, { ...options, config: prepared.config });
  if (!output.ok) return { ok: false, source, diagnostics: output.diagnostics };
  if (!sameDocumentMeaning(prepared.document, output.document))
    return writeFailure(source, options.file);
  return { ok: true, source, diagnostics: [], formatted };
}
