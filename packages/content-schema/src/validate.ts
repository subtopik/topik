import Markdoc, { type Config, type ValidateError } from "@markdoc/markdoc";
import { topikMarkdocConfig } from "./config";
import { parseTopikContent } from "./content";
import { toTopikContentDiagnostic, type TopikContentDiagnostic } from "./diagnostics";
import { extractTopikAssetOccurrences, validateTopikAssetReference } from "./asset-references";

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
  const errors = [
    ...markdocErrors.map(toTopikContentDiagnostic),
    ...extractTopikAssetOccurrences(source).flatMap((occurrence): TopikContentDiagnostic[] => {
      const validation = validateTopikAssetReference(occurrence.reference);
      const compiledAsset = validation.valid && validation.kind === "asset";
      if (
        validation.valid &&
        occurrence.kind !== "unsafe" &&
        (!compiledAsset || options.allowCompiledAssetReferences === true)
      ) {
        return [];
      }
      const namedReference = occurrence.reference.startsWith("asset:");
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
    }),
  ];
  return {
    valid: errors.every(
      (diagnostic) => diagnostic.level !== "error" && diagnostic.level !== "critical",
    ),
    errors,
    markdocErrors,
  };
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
