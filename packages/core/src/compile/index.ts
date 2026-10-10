import { compileManifest } from "./manifest";
import { CompileError, type CompileResult, type CompileValidationOptions } from "./shared";

export {
  compileResourceLinks,
  type CompileResourceLinksInput,
  type CompiledResourceReference,
  type CompileResourceReferenceTarget,
} from "./links";
export {
  discoverGuideResources,
  discoverWikiResources,
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
  PublicCompileError,
  type PublicCompileErrorId,
} from "./public-errors";

export interface CompileOptions {
  dir: string;
  validation?: CompileValidationOptions;
  /** Optional application-supplied inventory for explicit resource references. */
  referenceTargets?: readonly import("./links").CompileResourceReferenceTarget[];
}

/** Compile exactly the project declared by .topik.yaml in dir. */
export async function compile(options: CompileOptions): Promise<CompileResult> {
  return compileManifest(options);
}

export interface LintResult {
  diagnostics: CompileResult["diagnostics"];
}

export async function lint(options: CompileOptions): Promise<LintResult> {
  try {
    return { diagnostics: (await compile(options)).diagnostics };
  } catch (error) {
    if (error instanceof CompileError) return { diagnostics: error.diagnostics };
    throw error;
  }
}

export {
  compileManifest,
  loadTopikManifest,
  discoverManifestSources,
  ManifestSourceError,
  type ManifestCompileResult,
  type ManifestSourceDescriptor,
  type ManifestSourceProvenance,
} from "./manifest";
