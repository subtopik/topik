import { sanitizeTopikContentDiagnostic } from "@topik/content";
import { CompileError } from "../compile/shared";
import { ManifestSourceError } from "../compile/manifest";
import { PublicCompileError } from "../compile/public-errors";

/** Every code the source planners raise themselves. */
export type SourcePlanDiagnosticCode =
  | "asset-bytes-mismatch"
  | "asset-bytes-required"
  | "asset-path-invalid"
  | "asset-reference-unrepresentable"
  | "asset-source-missing"
  | "content-unrepresentable"
  | "create-authority-required"
  | "exclusive-authority-required"
  | "identity-ambiguous"
  | "initialization-collision"
  | "initialization-unproven"
  | "initialization-validation-failed"
  | "module-not-empty"
  | "operation-ambiguous"
  | "operation-inconsistent"
  | "operation-required"
  | "package-cohort-required"
  | "reference-context-invalid"
  | "reference-context-required"
  | "reference-target-removed"
  | "reference-target-unresolved"
  | "reference-unrepresentable"
  | "resource-invalid"
  | "resource-scope-denied"
  | "resource-unrepresentable"
  | "round-trip-mismatch"
  | "shared-authority-required"
  | "shared-authority-stale"
  | "shared-reference-scope-denied"
  | "shared-scope-denied"
  | "source-add-validation-failed"
  | "source-base-changed"
  | "source-creation-required"
  | "source-deletion-required"
  | "source-intent-mismatch"
  | "source-mapping-invalid"
  | "source-mapping-missing"
  | "source-path-collision"
  | "source-path-invalid"
  | "source-reference-unrepresentable"
  | "source-tree-invalid"
  | "source-validation-failed"
  | "source-version-collision"
  | "source-version-required"
  | "source-writer-incompatible";

export interface SourcePlanDiagnostic {
  /**
   * A planner code, or the stable ID of a compiler diagnostic passed through unchanged.
   * The `string & {}` member keeps the field assignable to and from `string`.
   */
  code: SourcePlanDiagnosticCode | (string & {});
  message: string;
  resource?: string;
  path?: string;
  /** One-based lines in the compiled document body, excluding frontmatter. */
  lines?: readonly number[];
  sourceIndex?: number;
  kind?: "wiki" | "collection" | "course";
  config?: string;
  /**
   * Original unexpected exception behind a generic fallback, for in-process debugging only.
   * It is non-enumerable, so serialized diagnostics never carry its private details.
   */
  readonly cause?: unknown;
}

export class SourcePlanningError extends Error {
  constructor(public readonly diagnostic: SourcePlanDiagnostic) {
    super(diagnostic.message);
    this.name = "SourcePlanningError";
  }
}

/** Stop planning with a declared code; empty `resource`/`path` values are left out. */
export function failSourcePlan(
  code: SourcePlanDiagnosticCode,
  message: string,
  resource?: string,
  path?: string,
): never {
  throw new SourcePlanningError({
    code,
    message,
    ...(resource ? { resource } : {}),
    ...(path ? { path } : {}),
  });
}

/** A complete source tree exceeded its bounds or held unsafe, duplicate or colliding paths. */
export class SourceTreeError extends TypeError {
  readonly diagnostic: SourcePlanDiagnostic;
  constructor(message: string) {
    super(message);
    this.name = "SourceTreeError";
    this.diagnostic = { code: "source-tree-invalid", message };
  }
}

/** Retain known safe compiler failures; arbitrary exception text never crosses the API. */
export function sourcePlanDiagnostics(
  error: unknown,
  fallback: SourcePlanDiagnostic,
): readonly SourcePlanDiagnostic[] {
  if (error instanceof SourcePlanningError || error instanceof SourceTreeError)
    return [error.diagnostic];
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
  return [Object.defineProperty({ ...fallback }, "cause", { value: error, enumerable: false })];
}
