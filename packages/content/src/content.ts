import type { ContentDocument } from "./model.js";
import { parseDocumentTree } from "./parser.js";
import { mergeTopikContentConfig, type TopikContentConfig } from "./config.js";

export type TopikContentNode = ContentDocument;

export interface ParseTopikContentOptions {
  /** @deprecated Compatibility-only; use validation/analysis options for diagnostic labels. */
  file?: string;
  /** @deprecated Compatibility-only; parsing always retains available source positions. */
  location?: boolean;
  config?: TopikContentConfig;
}

/** Parse the authoring tree. Use validateTopikContent at publication boundaries. */
export function parseTopikContent(
  source: string,
  options: ParseTopikContentOptions = {},
): ContentDocument {
  const config = mergeTopikContentConfig(options.config);
  const result = parseDocumentTree(source, config.components);
  if (!result.document) throw new Error("Content could not be parsed");
  return result.document;
}
