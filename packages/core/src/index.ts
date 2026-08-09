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
  compileAssetResources,
  isErrorDiagnostic,
  pagePathToName,
  type CompileOptions,
  type CompileWikiOptions,
  type CompileGuidesOptions,
  type CompileResult,
  type CompileValidationOptions,
  type LinkValidationPolicy,
  type LintResult,
  AssetCompilationError,
  loadAssetDescriptors,
  type AssetCompilationOptions,
  type AssetCompilationResult,
  type AssetPayload,
  type CompileAssetResourcesInput,
  type ContentBearingResource,
} from "./compile";
export { CompileError } from "./compile";
export type { Resource, ResourceType } from "./resource";

export { validateResources, type ValidationError, type ValidationResult } from "./validate";

export { watch, type WatchOptions, type Watcher } from "./watch";

/** Named Asset/v1 compilation, validation, identity, and migration APIs. */
export * from "./portable";
