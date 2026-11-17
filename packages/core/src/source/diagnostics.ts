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
  | "source-tree-too-large"
  | "source-validation-failed"
  | "source-version-collision"
  | "source-version-required"
  | "source-writer-incompatible";

/**
 * What kind of problem a diagnostic reports, for consumers that map diagnostics to their own
 * messages. A new code always belongs to one of these, so a mapping by category stays correct
 * when codes are added.
 *
 * - `request`: the operations, intent or desired resources contradict each other or are incomplete.
 * - `mapping`: a resource has no declared source to write to, or its source record is unusable.
 * - `version`: the source must opt in to `sourceVersion: 1`, or cannot.
 * - `authority`: the caller did not show the current bytes of a file the plan changes or creates.
 * - `scope`: the plan would change a resource or shared file the caller did not admit.
 * - `stale`: the pinned tree is not the tree the project was read from.
 * - `path`: a requested or derived file path is occupied or not portable.
 * - `reference`: a link or reference cannot be kept, resolved or carried over.
 * - `asset`: supplied media bytes or names do not match the desired Assets.
 * - `unrepresentable`: the desired value has no source form.
 * - `validation`: the written source does not compile to the desired resources.
 * - `tree`: the supplied tree is over a limit or holds unsafe paths.
 * - `incompatible`: the saved project was read by another writer or package cohort.
 * - `internal`: the writer failed unexpectedly. Nothing the author wrote is known to be wrong.
 */
export type SourcePlanDiagnosticCategory =
  | "request"
  | "mapping"
  | "version"
  | "authority"
  | "scope"
  | "stale"
  | "path"
  | "reference"
  | "asset"
  | "unrepresentable"
  | "validation"
  | "tree"
  | "incompatible"
  | "internal";

/** One category for every planner code; a code added without one fails the type check. */
const SOURCE_PLAN_DIAGNOSTIC_CATEGORIES: Readonly<
  Record<SourcePlanDiagnosticCode, SourcePlanDiagnosticCategory>
> = {
  "asset-bytes-mismatch": "asset",
  "asset-bytes-required": "asset",
  "asset-path-invalid": "asset",
  "asset-reference-unrepresentable": "unrepresentable",
  "asset-source-missing": "asset",
  "content-unrepresentable": "unrepresentable",
  "create-authority-required": "authority",
  "exclusive-authority-required": "authority",
  "identity-ambiguous": "request",
  "initialization-collision": "path",
  "initialization-unproven": "path",
  "initialization-validation-failed": "validation",
  "module-not-empty": "request",
  "operation-ambiguous": "request",
  "operation-inconsistent": "request",
  "operation-required": "request",
  "package-cohort-required": "request",
  "reference-context-invalid": "reference",
  "reference-context-required": "reference",
  "reference-target-removed": "reference",
  "reference-target-unresolved": "reference",
  "reference-unrepresentable": "unrepresentable",
  "resource-invalid": "request",
  "resource-scope-denied": "scope",
  "resource-unrepresentable": "unrepresentable",
  "round-trip-mismatch": "validation",
  "shared-authority-required": "authority",
  "shared-authority-stale": "authority",
  "shared-reference-scope-denied": "scope",
  "shared-scope-denied": "scope",
  "source-add-validation-failed": "validation",
  "source-base-changed": "stale",
  "source-creation-required": "request",
  "source-deletion-required": "request",
  "source-intent-mismatch": "request",
  "source-mapping-invalid": "mapping",
  "source-mapping-missing": "mapping",
  "source-path-collision": "path",
  "source-path-invalid": "path",
  "source-reference-unrepresentable": "unrepresentable",
  "source-tree-invalid": "tree",
  "source-tree-too-large": "tree",
  "source-validation-failed": "validation",
  "source-version-collision": "version",
  "source-version-required": "version",
  "source-writer-incompatible": "incompatible",
};

/**
 * The category of a diagnostic, or of a bare code.
 *
 * - `code` also carries compiler diagnostic IDs that pass through unchanged: a link diagnostic
 *   (`link-…`) is a `reference` problem, and every other compiler ID means the source does not
 *   compile, which is `validation`.
 * - A diagnostic with a `cause` is the generic fallback for an unexpected exception and is
 *   `internal`, whatever its code. `cause` is not enumerable, so pass the diagnostic itself,
 *   before it is serialized or copied; a bare code or a copy cannot show the difference.
 */
export function sourcePlanDiagnosticCategory(
  diagnostic: string | Pick<SourcePlanDiagnostic, "code" | "cause">,
): SourcePlanDiagnosticCategory {
  // Own-property presence, not the value: the thrown value can itself be `undefined`.
  if (typeof diagnostic !== "string" && Object.hasOwn(diagnostic, "cause")) return "internal";
  const code = typeof diagnostic === "string" ? diagnostic : diagnostic.code;
  if (Object.hasOwn(SOURCE_PLAN_DIAGNOSTIC_CATEGORIES, code))
    return SOURCE_PLAN_DIAGNOSTIC_CATEGORIES[code as SourcePlanDiagnosticCode];
  return code.startsWith("link-") ? "reference" : "validation";
}

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
  /** With `source-tree-too-large`: the bound that was exceeded, in `unit`. */
  limit?: number;
  /** With `source-tree-too-large`: the size of the supplied tree, in `unit`. */
  count?: number;
  /** With `source-tree-too-large`: what `limit` and `count` measure. */
  unit?: "files" | "bytes";
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
  /** `size` names the exceeded bound; without it the tree is invalid for another reason. */
  constructor(message: string, size?: { limit: number; count: number; unit: "files" | "bytes" }) {
    super(message);
    this.name = "SourceTreeError";
    this.diagnostic = size
      ? { code: "source-tree-too-large", message, ...size }
      : { code: "source-tree-invalid", message };
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
