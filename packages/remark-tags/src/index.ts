import type { Root } from "mdast";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Options as ToMarkdownOptions } from "mdast-util-to-markdown";
import type { Extension as MicromarkExtension } from "micromark-util-types";
import type { Plugin } from "unified";
import { tagSyntax } from "./syntax.js";
import { tagFromMarkdown } from "./from-markdown.js";
import { tagToMarkdown } from "./to-markdown.js";
import type { TagDeclarations, TagSyntaxOptions } from "./types.js";

export * from "./types.js";
export { tagSyntax, tagFromMarkdown, tagToMarkdown };
export { writeTextTemplate } from "./templates.js";

// Match the data fields used by remark-parse and remark-stringify without
// requiring either plugin as a runtime dependency.
declare module "unified" {
  interface Data {
    micromarkExtensions?: MicromarkExtension[];
    fromMarkdownExtensions?: Array<FromMarkdownExtension[] | FromMarkdownExtension>;
    toMarkdownExtensions?: ToMarkdownOptions[];
  }
}

/** Add declarative tag parsing and serialization to a remark processor. */
export const remarkTags: Plugin<[TagDeclarations, TagSyntaxOptions?], Root> = function (
  declarations,
  options = {},
) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(tagSyntax(declarations, options));
  (data.fromMarkdownExtensions ??= []).push(tagFromMarkdown(declarations, options));
  (data.toMarkdownExtensions ??= []).push(tagToMarkdown(declarations, options));
};

export default remarkTags;
