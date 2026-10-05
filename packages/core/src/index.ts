/** High-level parsers target the Topik input format. */
export {
  DEFAULT_ASSET_DIRECTORY,
  sourceAssetsConfigSchema,
  type SourceAssetsConfig,
  TOPIK_MANIFEST_FILENAME,
  TOPIK_MANIFEST_LIMITS,
  topikManifestSchema,
  topikManifestSourceSchema,
  parseTopikManifest,
  type TopikManifest,
  type TopikManifestSource,
  parseCollectionConfig,
  parseWikiConfig,
  type CollectionConfig,
  type WikiConfig,
} from "./config";

export {
  compileManifest,
  loadTopikManifest,
  discoverManifestSources,
  ManifestSourceError,
  type ManifestCompileResult,
  type ManifestSourceDescriptor,
  type ManifestSourceProvenance,
  compile,
  lint,
  compileWiki,
  compileGuides,
  compileAssetResources,
  createProjectAssetNameGenerator,
  type ProjectAssetNameOptions,
  type AssetNameInput,
  type AssetNameGenerator,
  isErrorDiagnostic,
  pagePathToName,
  publicCompileErrorMessage,
  PublicCompileError,
  type CompileOptions,
  type CompileWikiOptions,
  type CompileGuidesOptions,
  type CompileResult,
  type CompileValidationOptions,
  type PublicCompileErrorId,
  type LinkValidationPolicy,
  type LintResult,
  AssetCompilationError,
  type AssetCompilationOptions,
  type AssetCompilationResult,
  type AssetPayload,
  type CompileAssetResourcesInput,
  type CompiledResource,
  type ContentBearingResource,
} from "./compile";
export { CompileError } from "./compile";
export type { Resource, ResourceType, SourceResource } from "./resource";

export { validateResources, type ValidationError, type ValidationResult } from "./validate";

export {
  findFirstWikiPage,
  findWikiPageAncestors,
  hasWikiNavChildren,
  isExternalWikiDropdown,
  isExternalWikiTab,
  isInternalWikiDropdown,
  isInternalWikiTab,
  joinWikiPath,
  resolveWikiContentHref,
  resolveWikiNavigation,
  type ExternalWikiDropdown,
  type ExternalWikiTab,
  type InternalWikiDropdown,
  type InternalWikiTab,
  type ResolvedWikiContentLink,
  type ResolvedWikiNavigation,
  type ResolvedWikiPage,
  type WikiSwitcherNode,
} from "./wiki-navigation";

export { watch, type WatchOptions, type Watcher } from "./watch";

/** Compiler-derived Asset/v1 output, validation, identity, and safety APIs. */
export * from "./assets";
