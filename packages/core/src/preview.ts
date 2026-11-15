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
export interface PreviewDiagnostic {
  id: string;
  message: string;
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
  diagnostics: PreviewDiagnostic[];
  resources: R[];
  payloads: PreviewPayloadDescriptor[];
  courseNavigation: CourseNavigationIndex;
}
