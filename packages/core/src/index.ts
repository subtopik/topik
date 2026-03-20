/** High-level parsers target the Topik input format. */
export {
  parseCollectionConfig,
  parseWikiConfig,
  type CollectionConfig,
  type WikiConfig,
} from "./config";

export {
  compile,
  compileWiki,
  compileGuides,
  type CompileOptions,
  type CompileWikiOptions,
  type CompileGuidesOptions,
  type CompileResult,
} from "./compile";
export type { Resource, ResourceType } from "./resource";

export { validateResources, type ValidationError, type ValidationResult } from "./validate";
