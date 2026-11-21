import type { ContentDocument } from "./model.js";
import { parseCachedDocumentTree, type TopikContentCache } from "./parse-cache.js";
import { mergeTopikContentConfig, type TopikContentConfig } from "./config.js";

export type TopikContentNode = ContentDocument;

export interface ParseTopikContentOptions {
  config?: TopikContentConfig;
  /**
   * @internal Parse results shared with other calls given the same cache. The returned tree
   * is then shared and frozen.
   */
  cache?: TopikContentCache;
}

/** Parse the authoring tree. Use validateTopikContent at publication boundaries. */
export function parseTopikContent(
  source: string,
  options: ParseTopikContentOptions = {},
): ContentDocument {
  const config = mergeTopikContentConfig(options.config);
  const result = parseCachedDocumentTree(source, config.components, options.cache);
  if (!result.document) throw new Error("Content could not be parsed");
  return result.document;
}
