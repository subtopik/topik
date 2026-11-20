import type { ExtractTopikAssetOccurrencesOptions, TopikAssetOccurrence } from "./asset-references";
import { rewriteDocumentAssetOccurrences } from "./asset-references.js";
import { mutablePreparedDocument, prepareSource, writeFailure } from "./source.js";
import { serializeDocument } from "./writer.js";
import { FORMAT_VERSION } from "./parser.js";
import { locateMeaningDifference, sameDocumentMeaning } from "./document-meaning.js";
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
  const { document, index } = mutablePreparedDocument(prepared);
  // Application callbacks run only after admission. Their exceptions remain caller errors.
  rewriteDocumentAssetOccurrences(document, source, replace, options, index);
  let content: string;
  try {
    // Unchanged content keeps its authored spelling and therefore its tree positions.
    content = serializeDocument(document, prepared.config.components, FORMAT_VERSION, {
      preserveTreePositions: true,
    });
  } catch {
    return writeFailure(source, options.file);
  }
  const output = prepareSource(content, {
    file: options.file,
    config: prepared.config,
    allowCompiledAssetReferences: true,
    cache: options.cache,
  });
  if (!output.ok) return { ok: false, source, diagnostics: output.diagnostics };
  if (!sameDocumentMeaning(document, output.document))
    return writeFailure(source, options.file, locateMeaningDifference(document, output.document));
  return { ok: true, source, diagnostics: [], content };
}
