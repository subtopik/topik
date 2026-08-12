import { formatTopikContentAst, parseTopikContent } from "./content";
import type { TopikContentDiagnostic } from "./diagnostics";
import { validateTopikContent, type ValidateTopikContentOptions } from "./validate";

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
  const validation = validateTopikContent(source, options);
  if (!validation.valid) {
    return { ok: false, source, diagnostics: validation.errors };
  }
  return {
    ok: true,
    source,
    diagnostics: validation.errors,
    formatted: formatTopikContentAst(
      parseTopikContent(source, { file: options.file, location: true }),
    ),
  };
}
