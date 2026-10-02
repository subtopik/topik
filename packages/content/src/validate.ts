import { prepareSource, type ValidateTopikContentOptions } from "./source.js";
import type { TopikContentDiagnostic } from "./diagnostics.js";

export type { ValidateTopikContentOptions } from "./source.js";
export interface ValidateTopikContentResult {
  source: string;
  valid: boolean;
  errors: TopikContentDiagnostic[];
}

/** Source admission is the same boundary used by formatting and asset rewriting. */
export function validateTopikContent(
  source: string,
  options: ValidateTopikContentOptions = {},
): ValidateTopikContentResult {
  const result = prepareSource(source, options);
  return { source, valid: result.ok, errors: result.diagnostics };
}
