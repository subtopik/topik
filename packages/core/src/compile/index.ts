import type { FileSafety } from "../assets/files";
import { compileManifest, lintManifest } from "./manifest";
import { type CompileResult, type CompileValidationOptions } from "./shared";

export {
  compileResourceLinks,
  type CompileResourceLinksInput,
  type CompiledResourceReference,
  type CompileResourceReferenceTarget,
} from "./links";
export {
  discoverGuideResources,
  discoverWikiResources,
  discoverCourseResources,
  type DiscoverResourceOptions,
  type SourceResourceDiscovery,
} from "./discovery";

export { compileWiki, pagePathToName } from "./wiki";
export type { CompileWikiOptions } from "./wiki";
export { compileGuides } from "./guide";
export type { CompileGuidesOptions } from "./guide";
export { compileCourse } from "./course";
export type { CompileCourseOptions } from "./course";
export {
  classifyCompileFailure,
  type CompileFailureClassification,
  type CompileFailureKind,
} from "./failure";
export {
  compileAssetResources,
  AssetCompilationError,
  type AssetCompilationOptions,
  type AssetNameInput,
  type AssetNameGenerator,
  type AssetCompilationResult,
  type AssetPayload,
  type CompileAssetResourcesInput,
  type CompiledResource,
  type ContentBearingResource,
} from "./assets";
export { createProjectAssetNameGenerator, type ProjectAssetNameOptions } from "./asset-names";
export type { Resource } from "../resource";
export {
  CompileError,
  isErrorDiagnostic,
  type CompileResult,
  type CompileValidationOptions,
  type LinkValidationPolicy,
} from "./shared";
export {
  publicCompileErrorMessage,
  publicCompileReasonMessage,
  PublicCompileError,
  type PublicCompileErrorId,
  type PublicCompileErrorReason,
} from "./public-errors";

export interface CompileOptions {
  dir: string;
  /**
   * How manifest, configuration and asset files are read where descriptor-anchored traversal
   * is unavailable (every platform except Linux). Defaults to `DEFAULT_FILE_SAFETY`.
   */
  fileSafety?: FileSafety;
  /**
   * Absolute path of the Git executable used inside a Git checkout, in place of the fixed
   * trusted locations. It must pass the same owner and mode checks. Never read from project
   * files. A malformed value throws a `TypeError`.
   */
  gitExecutable?: string;
  validation?: CompileValidationOptions;
  /** Optional application-supplied inventory for explicit resource references. */
  referenceTargets?: readonly import("./links").CompileResourceReferenceTarget[];
  /**
   * @internal Content results kept from earlier compilations of this project, so unchanged
   * documents are not parsed and validated again. The caller prunes it after each compilation.
   */
  contentMemo?: import("./content-memo").ContentMemo;
}

/** Compile exactly the project declared by .topik.yaml in dir. */
export async function compile(options: CompileOptions): Promise<CompileResult> {
  return compileManifest(options);
}

export interface LintResult {
  /** Every content and link diagnostic, errors and warnings, from every source. */
  diagnostics: CompileResult["diagnostics"];
  /**
   * Problems that stopped part of the check, each also an error: a source whose configuration
   * or frontmatter could not be read, a check across sources, or an image or download. An Asset
   * failure names the documents it was found in.
   */
  failures: LintFailure[];
}

export interface LintFailure {
  /** A `PublicCompileError`, `ManifestSourceError` or `AssetCompilationError`. */
  error: unknown;
  /** Project-relative paths of the documents that reference a failed Asset. */
  documents?: readonly string[];
}

/**
 * Check the project like {@link compile} without producing output, and report every problem
 * found instead of stopping at the first stage with an error. Only a manifest that cannot be
 * loaded throws.
 */
export async function lint(options: CompileOptions): Promise<LintResult> {
  return lintManifest(options);
}

export {
  compileManifest,
  loadTopikManifest,
  discoverManifestSources,
  listManifestDocuments,
  ManifestSourceError,
  type ManifestCompileResult,
  type ManifestSourceDescriptor,
  type ManifestSourceProvenance,
} from "./manifest";
