import { sanitizeTopikContentDiagnostic } from "@topik/content";
import { CompileError } from "../compile/shared";
import { ManifestSourceError } from "../compile/manifest";
import { PublicCompileError } from "../compile/public-errors";

export interface SourcePlanDiagnostic {
  code: string;
  message: string;
  resource?: string;
  path?: string;
  /** One-based lines in the compiled document body, excluding frontmatter. */
  lines?: readonly number[];
  sourceIndex?: number;
  kind?: "wiki" | "collection" | "course";
  config?: string;
}

export class SourcePlanningError extends Error {
  constructor(public readonly diagnostic: SourcePlanDiagnostic) {
    super(diagnostic.message);
    this.name = "SourcePlanningError";
  }
}

/** Retain known safe compiler failures; arbitrary exception text never crosses the API. */
export function sourcePlanDiagnostics(
  error: unknown,
  fallback: SourcePlanDiagnostic,
): readonly SourcePlanDiagnostic[] {
  if (error instanceof SourcePlanningError) return [error.diagnostic];
  if (error instanceof CompileError && error.diagnostics.length) {
    return error.diagnostics.slice(0, 64).map((diagnostic) => {
      const safe = sanitizeTopikContentDiagnostic(diagnostic);
      return {
        code: /^[a-zA-Z0-9_-]{1,96}$/.test(safe.id) ? safe.id : "source-validation-failed",
        message: safe.message,
        ...(safe.file && safe.file.length <= 768 ? { path: safe.file } : {}),
        lines: safe.lines.filter((line) => Number.isSafeInteger(line) && line > 0).slice(0, 8),
      };
    });
  }
  if (error instanceof PublicCompileError) {
    const safe = new PublicCompileError(error.id, error.location);
    return [
      {
        code: safe.id,
        message: safe.message,
        ...(safe.location ? { path: safe.location } : {}),
        ...(error instanceof ManifestSourceError
          ? {
              sourceIndex: error.sourceIndex,
              ...(error.kind ? { kind: error.kind } : {}),
              ...(safe.location ? { config: safe.location } : {}),
            }
          : {}),
      },
    ];
  }
  return [fallback];
}
