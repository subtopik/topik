import type { ExtractTopikAssetOccurrencesOptions, TopikAssetOccurrence } from "./asset-references";
import { rewriteDocumentAssetOccurrences } from "./asset-references.js";
import { prepareSource, writeFailure } from "./source.js";
import { serializeDocument } from "./writer.js";
import { sameDocumentMeaning } from "./document-meaning.js";
import type { TopikContentDiagnostic } from "./diagnostics";
import { type ValidateTopikContentOptions } from "./validate";

export interface RewriteTopikAssetOccurrencesOptions
  extends ExtractTopikAssetOccurrencesOptions, ValidateTopikContentOptions {}

export interface RewriteTopikAssetOccurrencesSuccess {
  ok: true;
  /** Exact caller-supplied source before rewriting. */
  source: string;
  diagnostics: TopikContentDiagnostic[];
  /** Rewritten content. Replacements are validated, including compiler-generated Asset references. */
  content: string;
}

export interface RewriteTopikAssetOccurrencesFailure {
  ok: false;
  /** Exact caller-supplied source, unchanged and unformatted. */
  source: string;
  diagnostics: TopikContentDiagnostic[];
}

export type RewriteTopikAssetOccurrencesResult =
  | RewriteTopikAssetOccurrencesSuccess
  | RewriteTopikAssetOccurrencesFailure;

export function rewriteTopikAssetOccurrences(
  source: string,
  replace: (occurrence: TopikAssetOccurrence) => string | undefined,
  options: RewriteTopikAssetOccurrencesOptions = {},
): RewriteTopikAssetOccurrencesResult {
  const prepared = prepareSource(source, options);
  if (!prepared.ok) return prepared;
  // Application callbacks run only after admission. Their exceptions remain caller errors.
  rewriteDocumentAssetOccurrences(prepared.document, source, replace, options, prepared.index);
  let content: string;
  try {
    content = serializeDocument(prepared.document, prepared.config.components);
  } catch {
    return writeFailure(source, options.file);
  }
  const output = prepareSource(content, {
    file: options.file,
    config: prepared.config,
    allowCompiledAssetReferences: true,
  });
  if (!output.ok) return { ok: false, source, diagnostics: output.diagnostics };
  if (!sameDocumentMeaning(prepared.document, output.document))
    return writeFailure(source, options.file);
  return { ok: true, source, diagnostics: [], content };
}
