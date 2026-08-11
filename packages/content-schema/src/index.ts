export { topikMarkdocConfig } from "./config";
export {
  TOPIK_ASSET_REFERENCE_VERSION,
  TOPIK_GENERATED_ASSET_NAME_PATTERN,
  extractTopikAssetOccurrences,
  removeInvalidTopikAssetReferences,
  rewriteTopikAssetOccurrences,
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
export {
  formatTopikContent,
  parseTopikContent,
  type ParseTopikContentOptions,
  type TopikContentNode,
} from "./content";
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
  type TopikAttributeType,
  type TopikAssetReferenceDefinition,
  type TopikAssetReferenceRole,
  type TopikComponentAttributeDefinition,
  type TopikComponentDefinition,
  type TopikComponentKind,
  type TopikComponentName,
} from "./components";
export {
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
