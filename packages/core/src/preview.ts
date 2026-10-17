import type { Resource } from "./resource";
import type { AssetPayload } from "./compile/assets";

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
export interface PreviewState {
  protocol: typeof TOPIK_PREVIEW_PROTOCOL;
  sessionId: string;
  sequence: number;
  /** Last successful generation, retained during compiling/error; null before first success. */
  generation: number | null;
  status: "compiling" | "ready" | "error";
  diagnostics: PreviewDiagnostic[];
  resources: Resource[];
  payloads: PreviewPayloadDescriptor[];
  courseNavigation: CourseNavigationIndex;
}
