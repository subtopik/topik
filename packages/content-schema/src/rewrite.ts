import type { ExtractTopikAssetOccurrencesOptions, TopikAssetOccurrence } from "./asset-references";
import { rewriteTopikAssetOccurrencesUnchecked } from "./asset-references";
import type { TopikContentDiagnostic } from "./diagnostics";
import { validateTopikContent, type ValidateTopikContentOptions } from "./validate";

export interface RewriteTopikAssetOccurrencesOptions
  extends ExtractTopikAssetOccurrencesOptions, ValidateTopikContentOptions {}

export interface RewriteTopikAssetOccurrencesSuccess {
  ok: true;
  /** Exact caller-supplied source before rewriting. */
  source: string;
  diagnostics: TopikContentDiagnostic[];
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
  const validation = validateTopikContent(source, {
    ...(options.file === undefined ? {} : { file: options.file }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.allowCompiledAssetReferences === undefined
      ? {}
      : { allowCompiledAssetReferences: options.allowCompiledAssetReferences }),
  });
  if (!validation.valid) {
    return { ok: false, source, diagnostics: validation.errors };
  }

  return {
    ok: true,
    source,
    diagnostics: validation.errors,
    content: rewriteTopikAssetOccurrencesUnchecked(source, replace, options),
  };
}
