export { components, getEffectiveProps } from "./registry.js";
export type {
  AttributeDefinition,
  ChildConstraint,
  ComponentDefinition,
  ComponentSchema,
  Registry,
} from "./registry.js";
export type {
  Branch,
  Component,
  Conditional,
  ContentDocument,
  Diagnostic,
  ParseResult,
  Scalar,
  Variable,
} from "./model.js";
export type { Expression } from "./expressions.js";
export { validateDocument } from "./validation.js";
export { FORMAT_VERSION, formatDocument, parseDocument, writeDocument } from "./markdown.js";
export { rewriteAssets } from "./assets.js";
export { ContentEvaluationError, evaluateDocument } from "./evaluate.js";
export { CONTENT_LIMITS, ContentLimitError } from "./limits.js";

export {
  mergeTopikContentConfig,
  type TopikContentConfig,
  type ResolvedTopikContentConfig,
} from "./config.js";
export {
  TOPIK_ASSET_REFERENCE_VERSION,
  TOPIK_GENERATED_ASSET_NAME_PATTERN,
  extractTopikAssetOccurrences,
  removeInvalidTopikAssetReferences,
  isTopikGeneratedAssetName,
  parseTopikGeneratedAssetName,
  topikAssetReferenceSlots,
  validateTopikAssetReference,
  type ExtractTopikAssetOccurrencesOptions,
  type TopikAssetOccurrence,
  type TopikAssetOccurrenceKind,
  type TopikAssetOccurrenceSemantics,
  type TopikAssetReferenceSlot,
  type TopikAssetReferenceValidation,
  type TopikGeneratedAssetName,
} from "./asset-references";
export { parseTopikContent, type ParseTopikContentOptions, type TopikContentNode } from "./content";
export {
  formatTopikContent,
  type FormatTopikContentFailure,
  type FormatTopikContentOptions,
  type FormatTopikContentResult,
  type FormatTopikContentSuccess,
} from "./format";
export {
  rewriteTopikAssetOccurrences,
  type RewriteTopikAssetOccurrencesFailure,
  type RewriteTopikAssetOccurrencesOptions,
  type RewriteTopikAssetOccurrencesResult,
  type RewriteTopikAssetOccurrencesSuccess,
} from "./rewrite";
export { assignTopikHeadingIds, type TopikHeading } from "./headings";
export {
  analyzeTopikContent,
  removeInvalidTopikNavigationReferences,
  validateTopikNavigationHref,
  validateTopikHref,
  type AnalyzeTopikContentOptions,
  type AnalyzeTopikContentResult,
  type TopikAnalyzedHeading,
  type TopikContentLink,
  type TopikContentLinkKind,
} from "./links";
export {
  BADGE_VARIANTS,
  CALLOUT_VARIANTS,
  QUIZ_QUESTION_TYPES,
  TOPIK_CONTENT_SCHEMA_VERSION,
  topikComponents,
  type TopikAssetReferenceDefinition,
  type TopikAssetReferenceRole,
  type TopikComponentAttributeDefinition,
  type TopikComponentDefinition,
  type TopikComponentName,
} from "./registry.js";
export {
  sanitizeTopikDiagnosticFile,
  sanitizeTopikContentDiagnostic,
  topikLinkDiagnosticMessage,
  toTopikContentDiagnostic,
  type TopikContentDiagnostic,
  type TopikContentDiagnosticLevel,
} from "./diagnostics";
export {
  validateTopikContent,
  type ValidateTopikContentOptions,
  type ValidateTopikContentResult,
} from "./validate";
export type { CompiledTopikContent } from "./compiled";

export {
  ContentTag,
  isContentTag,
  transformTopikContent,
  type RenderableTreeNode,
} from "./render.js";
export {
  compileTopikContent,
  type CompileTopikContentOptions,
  type CompileTopikContentResult,
  type CompileTopikContentSuccess,
  type CompileTopikContentFailure,
} from "./compile.js";
export type TopikComponentKind = "block" | "inline";
export type TopikAttributeType = "string" | "number" | "boolean" | "enum";
