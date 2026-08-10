import Markdoc, { type Config, type ValidateError } from "@markdoc/markdoc";
import { topikMarkdocConfig } from "./config";
import { parseTopikContent } from "./content";
import { toTopikContentDiagnostic, type TopikContentDiagnostic } from "./diagnostics";
import {
  extractTopikAssetOccurrences,
  type TopikAssetOccurrence,
  validateTopikAssetReference,
} from "./asset-references";

export interface ValidateTopikContentOptions {
  /** Source file path used in Markdoc locations and diagnostics. */
  file?: string;
  /** Additional Markdoc config to merge after the Topik defaults. */
  config?: Config;
  /** Permit compiler-produced `asset:auto-v1-*` references at an output-consumer boundary. */
  allowCompiledAssetReferences?: boolean;
}

export interface ValidateTopikContentResult {
  valid: boolean;
  errors: TopikContentDiagnostic[];
  markdocErrors: ValidateError[];
}

export function validateTopikContent(
  source: string,
  options: ValidateTopikContentOptions = {},
): ValidateTopikContentResult {
  const ast = parseTopikContent(source, { file: options.file, location: true });
  const markdocErrors = Markdoc.validate(ast, mergeConfigs(topikMarkdocConfig, options.config));
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
  ];
  return {
    valid: errors.every(
      (diagnostic) => diagnostic.level !== "error" && diagnostic.level !== "critical",
    ),
    errors,
    markdocErrors,
  };
}

/** Parsed HTTP(S) destinations remain policy-relevant when exact Markdown pairing is unavailable. */
function effectiveExternalReference(occurrence: TopikAssetOccurrence): string {
  return occurrence.reference.length === 0 && /^https?:/iu.test(occurrence.parsedReference)
    ? occurrence.parsedReference
    : occurrence.reference;
}

function mergeConfigs(base: Config, override: Config = {}): Config {
  return {
    ...base,
    ...override,
    nodes: { ...base.nodes, ...override.nodes },
    tags: { ...base.tags, ...override.tags },
    variables: { ...base.variables, ...override.variables },
    functions: { ...base.functions, ...override.functions },
    partials: { ...base.partials, ...override.partials },
    validation: { ...base.validation, ...override.validation },
  };
}
