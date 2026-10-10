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
  parseCourseConfig,
  type CollectionConfig,
  type WikiConfig,
  type CourseConfig,
  type CourseModuleConfig,
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
  compileCourse,
  compileAssetResources,
  compileResourceLinks,
  discoverGuideResources,
  discoverWikiResources,
  type DiscoverResourceOptions,
  type SourceResourceDiscovery,
  type CompileResourceLinksInput,
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
  type CompileCourseOptions,
  type CompileResult,
  type CompileValidationOptions,
  type CompiledResourceReference,
  type CompileResourceReferenceTarget,
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
  resolveWikiContentReference,
  resolveWikiNavigation,
  type ExternalWikiDropdown,
  type ExternalWikiTab,
  type InternalWikiDropdown,
  type InternalWikiTab,
  type ResolvedWikiContentLink,
  type ResolvedWikiContentReference,
  type ResolvedWikiNavigation,
  type ResolvedWikiPage,
  type WikiSwitcherNode,
} from "./wiki-navigation";

export {
  resolveCourseNavigation,
  resolveCourseContentHref,
  resolveCourseContentReference,
  type CourseReferenceContext,
  type ResolvedCoursePage,
  type ResolvedCourseNavigation,
  type ResolvedCourseContentLink,
  type ResolvedCourseContentReference,
} from "./course-navigation";

export { watch, type WatchOptions, type Watcher } from "./watch";

/** Compiler-derived Asset/v1 output, validation, identity, and safety APIs. */
export * from "./assets";

export {
  readSourceProject,
  digestSourceTree,
  digestSourceResourceGraph,
  SOURCE_WRITER_VERSION,
  SOURCE_WRITER_DESCRIPTOR,
  SOURCE_PROJECT_LIMITS,
  type SourceTreeFile,
  type SourceProject,
  type SourceDocumentProvenance,
  type SourceFieldOrigin,
  type SourceConfigurationProvenance,
} from "./source/project";
export {
  planSourceUpdates,
  type PlanSourceUpdatesInput,
  type SourceResourceOperation,
  type SourceWriteAuthority,
  type SourceSharedAuthority,
  type SourceExclusiveAuthority,
  type SourceFileChange,
  type SourceUpdatePlan,
  type SourcePlanResult,
  type SourcePlanDiagnostic,
} from "./source/plan";
export type { SourceByteRange, SourceByteEdit, SourceFieldEvidence } from "./source/syntax";
export {
  initializeSourceProject,
  addSourceToProject,
  type AddSourceToProjectInput,
  type InitializeSourceProjectInput,
  type SourceInitializationIntent,
  type SourceMediaSelection,
} from "./source/initialize";
