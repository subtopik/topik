import type { ValidateError, ValidationError } from "@markdoc/markdoc";

export type TopikContentDiagnosticLevel = ValidationError["level"];

export interface TopikContentDiagnostic {
  /** Stable diagnostic identifier. */
  id: string;
  /** Markdoc node type that produced the diagnostic. */
  type: string;
  /** Diagnostic severity. */
  level: TopikContentDiagnosticLevel;
  /** Human-readable diagnostic message. */
  message: string;
  /** One-based source lines associated with the diagnostic, when available. */
  lines: number[];
  /** Optional source file path provided to the Markdoc parser. */
  file?: string;
}

export function toTopikContentDiagnostic(error: ValidateError): TopikContentDiagnostic {
  return {
    id: error.error.id,
    type: error.type,
    level: error.error.level,
    message: error.error.message,
    lines: error.lines,
    ...(error.location?.file ? { file: error.location.file } : {}),
  };
}
