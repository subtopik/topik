import Markdoc, { type Node } from "@markdoc/markdoc";

export type TopikContentNode = Node;

export interface ParseTopikContentOptions {
  /** Source file path used in Markdoc locations and diagnostics. */
  file?: string;
  /** Include source locations in the parsed tree. */
  location?: boolean;
}

export function parseTopikContent(
  source: string,
  options: ParseTopikContentOptions = {},
): TopikContentNode {
  return Markdoc.parse(source, options);
}

export function formatTopikContent(ast: TopikContentNode): string {
  return Markdoc.format(ast);
}
