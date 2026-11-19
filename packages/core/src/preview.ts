import type { Resource } from "./resource";
import type { AssetPayload } from "./compile/assets";

/** Union of every schema-generated resource type, re-exported for browser consumers. */
export type { Resource } from "./resource";

/** Browser-safe capability and wire types. No filesystem imports at runtime. */
export const TOPIK_PREVIEW_PROTOCOL = "topik-preview/1" as const;
export interface CourseNavigationModule {
  name: string;
  declarationIndex: number;
  pages: { name: string; declarationIndex: number }[];
}
export type CourseNavigationIndex = Record<string, { modules: CourseNavigationModule[] }>;
export type PreviewPayloadDescriptor = Omit<AssetPayload, "bytes">;
/** Most diagnostics one state carries; the rest are counted in `omittedDiagnostics`. */
export const PREVIEW_DIAGNOSTIC_LIMIT = 100;
/** Project-relative source position of a diagnostic, as the CLI prints it. */
export interface PreviewDiagnosticLocation {
  /** Root-relative path with `/` separators, never absolute. */
  path: string;
  /** One-based line, when known. */
  line?: number;
  /** One-based column, when known. */
  column?: number;
}
export interface PreviewDiagnostic {
  /** Stable identifier, such as `link-page-not-found`. */
  id: string;
  /** Display wording; not a stable surface. */
  message: string;
  /** `error` blocks the compilation; `warning` is published on `ready` states too. */
  severity?: "error" | "warning";
  location?: PreviewDiagnosticLocation;
  /** Resource whose source the diagnostic is in, when known from the last successful generation. */
  resource?: { type: string; name: string };
}
/**
 * One complete preview snapshot, as sent in each `preview-state` event.
 *
 * `R` is the type of each entry in `resources`. It defaults to {@link Resource}, the union of
 * the schema-generated resource types. A client that validates each received resource itself
 * can pass its own resource type, for example a narrower union, instead of redefining this
 * interface.
 */
export interface PreviewState<R = Resource> {
  protocol: typeof TOPIK_PREVIEW_PROTOCOL;
  sessionId: string;
  sequence: number;
  /** Last successful generation, retained during compiling/error; null before first success. */
  generation: number | null;
  status: "compiling" | "ready" | "error";
  /** At most {@link PREVIEW_DIAGNOSTIC_LIMIT}, errors first. */
  diagnostics: PreviewDiagnostic[];
  /** How many further diagnostics were left out; present only when some were. */
  omittedDiagnostics?: number;
  resources: R[];
  payloads: PreviewPayloadDescriptor[];
  courseNavigation: CourseNavigationIndex;
}
