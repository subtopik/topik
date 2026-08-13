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

/** @internal AST formatting cannot preserve invalid source and is not a package export. */
export function formatTopikContentAst(ast: TopikContentNode): string {
  return Markdoc.format(ast);
}
