import Markdoc, { type Config } from "@markdoc/markdoc";
import { mergeTopikMarkdocConfig } from "./config";
import { parseTopikContent } from "./content";
import {
  sanitizeTopikContentDiagnostic,
  toTopikContentDiagnostic,
  type TopikContentDiagnostic,
} from "./diagnostics";
import {
  extractTopikAssetOccurrences,
  type TopikAssetOccurrence,
  validateTopikAssetReference,
} from "./asset-references";

export interface ValidateTopikContentOptions {
  /** Source file path used in Markdoc locations and diagnostics. */
  file?: string;
  /** Additive Markdoc config; canonical Topik node and tag schemas retain precedence. */
  config?: Config;
  /** Permit compiler-produced `asset:auto-v1-*` references at an output-consumer boundary. */
  allowCompiledAssetReferences?: boolean;
}

export interface ValidateTopikContentResult {
  /** Exact caller-supplied source. This field is intentionally not diagnostic text. */
  source: string;
  valid: boolean;
  errors: TopikContentDiagnostic[];
}

export function validateTopikContent(
  source: string,
  options: ValidateTopikContentOptions = {},
): ValidateTopikContentResult {
  const ast = parseTopikContent(source, { file: options.file, location: true });
  const markdocErrors = Markdoc.validate(ast, mergeTopikMarkdocConfig(options.config));
  const assetOccurrences = extractTopikAssetOccurrences(source);
  const unsafeHttpLinkOccurrences = extractTopikAssetOccurrences(source, {
    includeGenericLinkCandidates: true,
  }).filter(
    (occurrence) =>
      occurrence.slot === "link.href" &&
      occurrence.kind === "unsafe" &&
      /^https?:/iu.test(occurrence.parsedReference),
  );
  const errors = [
    ...markdocErrors.map(toTopikContentDiagnostic),
    ...[...assetOccurrences, ...unsafeHttpLinkOccurrences].flatMap(
      (occurrence): TopikContentDiagnostic[] => {
        const reference = effectiveExternalReference(occurrence);
        const validation = validateTopikAssetReference(reference);
        const compiledAsset = validation.valid && validation.kind === "asset";
        if (
          validation.valid &&
          (occurrence.kind !== "unsafe" || reference !== occurrence.reference) &&
          (!compiledAsset || options.allowCompiledAssetReferences === true)
        ) {
          return [];
        }
        const namedReference = occurrence.kind === "asset" || occurrence.kind === "reserved-asset";
        const external = validation.valid
          ? validation.kind === "external-https"
          : validation.failureKind === "external";
        return [
          {
            id: namedReference
              ? "TOPIK_ASSET_REFERENCE_MALFORMED"
              : external
                ? "TOPIK_EXTERNAL_REFERENCE_UNSAFE"
                : "TOPIK_ASSET_PATH_INVALID",
            type: occurrence.slot,
            level: "error",
            message: namedReference
              ? compiledAsset
                ? "Compiler-generated Asset references are not valid authoring input"
                : "Asset reference has an invalid generated name"
              : external
                ? "Asset reference requires credential-free HTTPS"
                : "Local asset reference is not canonical topik-asset-reference-v1",
            lines: [],
            ...(options.file === undefined ? {} : { file: options.file }),
          },
        ];
      },
    ),
  ].map(sanitizeTopikContentDiagnostic);
  return {
    source,
    valid: errors.every(
      (diagnostic) => diagnostic.level !== "error" && diagnostic.level !== "critical",
    ),
    errors,
  };
}

/** Parsed HTTP(S) destinations remain policy-relevant when exact Markdown pairing is unavailable. */
function effectiveExternalReference(occurrence: TopikAssetOccurrence): string {
  return occurrence.reference.length === 0 && /^https?:/iu.test(occurrence.parsedReference)
    ? occurrence.parsedReference
    : occurrence.reference;
}
