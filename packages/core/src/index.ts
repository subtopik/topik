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
  type AssetCompilationOptions,
  type AssetCompilationResult,
  type AssetPayload,
  type CompileAssetResourcesInput,
  type ContentBearingResource,
} from "./compile";
export { CompileError } from "./compile";
export type { Resource, ResourceType, SourceResource } from "./resource";

export { validateResources, type ValidationError, type ValidationResult } from "./validate";

export { watch, type WatchOptions, type Watcher } from "./watch";

/** Compiler-derived Asset/v1 output, validation, identity, and safety APIs. */
export * from "./portable";
