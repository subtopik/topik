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
  pagePathToName,
  type CompileOptions,
  type CompileWikiOptions,
  type CompileGuidesOptions,
  type CompileResult,
  type CompileValidationOptions,
  type LinkValidationPolicy,
  type LintResult,
} from "./compile";
export { CompileError } from "./compile";
export type { Resource, ResourceType } from "./resource";

export { validateResources, type ValidationError, type ValidationResult } from "./validate";

export { watch, type WatchOptions, type Watcher } from "./watch";
