import { prepareSource, type ValidateTopikContentOptions } from "./source.js";
import type { TopikContentDiagnostic } from "./diagnostics.js";

export type { ValidateTopikContentOptions } from "./source.js";
export interface ValidateTopikContentResult {
  ok: boolean;
  source: string;
  /** Why the source is refused; empty when `ok` is true. */
  diagnostics: TopikContentDiagnostic[];
}

/** Source admission is the same boundary used by formatting and asset rewriting. */
export function validateTopikContent(
  source: string,
  options: ValidateTopikContentOptions = {},
): ValidateTopikContentResult {
  const result = prepareSource(source, options);
  return { ok: result.ok, source, diagnostics: result.diagnostics };
}
