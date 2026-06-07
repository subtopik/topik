import Markdoc, { type Config, type ValidateError } from "@markdoc/markdoc";
import { topikMarkdocConfig } from "./config";
import { parseTopikContent } from "./content";
import { toTopikContentDiagnostic, type TopikContentDiagnostic } from "./diagnostics";

export interface ValidateTopikContentOptions {
  /** Source file path used in Markdoc locations and diagnostics. */
  file?: string;
  /** Additional Markdoc config to merge after the Topik defaults. */
  config?: Config;
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
  const errors = markdocErrors.map(toTopikContentDiagnostic);
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
