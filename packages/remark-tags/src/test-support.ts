import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkTags, {
  tagFromMarkdown,
  tagSyntax,
  tagToMarkdown,
  type TagDeclarations,
} from "./index.js";

export const declarations = {
  badge: { kind: "inline" },
  hint: { kind: "inline" },
  panel: { kind: "block" },
  media: { kind: "block" },
} satisfies TagDeclarations;

export function parse(source: string, tags: TagDeclarations = declarations): Root {
  return fromMarkdown(source, {
    extensions: [gfm(), tagSyntax(tags)],
    mdastExtensions: [...gfmFromMarkdown(), tagFromMarkdown(tags)],
  });
}

export function write(tree: Root, tags: TagDeclarations = declarations): string {
  return toMarkdown(tree, { extensions: [gfmToMarkdown(), tagToMarkdown(tags)] });
}

export function processor() {
  return unified()
    .use(remarkParse)
    .use(remarkTags, declarations)
    .use(remarkStringify)
    .data("micromarkExtensions", [gfm()])
    .data("fromMarkdownExtensions", gfmFromMarkdown())
    .data("toMarkdownExtensions", [gfmToMarkdown()]);
}

// Positions describe a particular spelling. All semantic fields stay in the
// comparison, including empty attributes, breaks, and list spread.
export function meaning(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(meaning);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "position")
        .map(([key, item]) => [key, meaning(item)]),
    );
  return value;
}
