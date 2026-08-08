/** High-level parsers target the Topik input format. */
export {
  parseCollectionConfig,
  parseWikiConfig,
  type CollectionConfig,
  type WikiConfig,
} from "./config";

export {
  compile,
  lint,
  compileWiki,
  compileGuides,
  compilePortableResourceArtifacts,
  isErrorDiagnostic,
  pagePathToName,
  type CompileOptions,
  type CompileWikiOptions,
  type CompileGuidesOptions,
  type CompileResult,
  type CompileValidationOptions,
  type LinkValidationPolicy,
  type LintResult,
  PortableAssetCompilationError,
  TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
  type CompilePortableResourceArtifactsInput,
  type ContentBearingResource,
  type PortableAssetCompilationOptions,
  type PortableAssetKeyStateV1,
  type PortableResourceArtifact,
  type PortableResourceCompilationResult,
} from "./compile";
export { CompileError } from "./compile";
export type { Resource, ResourceType } from "./resource";

export { validateResources, type ValidationError, type ValidationResult } from "./validate";

export { watch, type WatchOptions, type Watcher } from "./watch";

/** Portable AssetManifest/v1 compilation and validation APIs. */
export * from "./portable";
