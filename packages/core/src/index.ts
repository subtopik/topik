/** High-level parsers target the wiki-focused Topik input format. */
export {
  parseTopikConfig,
  parseWikiConfig,
  type TopikConfig,
  type Collection,
  type WikiConfig,
} from "./config";

export {
  compile,
  compileWiki,
  type CompileOptions,
  type CompileWikiOptions,
  type CompileResult,
} from "./compile";
export type { Resource, ResourceType } from "./resource";

export { validateResources, type ValidationError, type ValidationResult } from "./validate";
