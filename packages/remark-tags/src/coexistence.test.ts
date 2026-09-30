import type { Root } from "mdast";
import { describe, expect, test } from "vite-plus/test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown, directiveToMarkdown } from "mdast-util-directive";
import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { remarkTags, tagFromMarkdown, tagSyntax, tagToMarkdown } from "./index.js";
import { meaning } from "./test-support.js";

const declarations = {
  badge: { kind: "inline" },
  tooltip: { kind: "inline" },
  callout: { kind: "block" },
  rule: { kind: "block" },
} as const;
const options = { expressions: true };

function parse(source: string, tagsFirst: boolean): Root {
  const syntax = [tagSyntax(declarations, options), directive()];
  const readers = [tagFromMarkdown(declarations, options), directiveFromMarkdown()];
  return fromMarkdown(source, {
    extensions: tagsFirst ? syntax : syntax.reverse(),
    mdastExtensions: tagsFirst ? readers : readers.reverse(),
  });
}

function write(tree: Root, tagsFirst: boolean): string {
  const writers = [tagToMarkdown(declarations, options), directiveToMarkdown()];
  return toMarkdown(tree, { extensions: tagsFirst ? writers : writers.reverse() });
}

describe.each([true, false])(
  "native directive coexistence (tags parse first: %s)",
  (parseFirst) => {
    test.each([true, false])(
      "keeps both syntaxes distinct (tags write first: %s)",
      (writeFirst) => {
        const source = `:badge[Native badge] and {% badge text="Tag badge" /%}.

::rule[Native leaf]

{% rule /%}

:::callout
Native container.
:::

{% callout %}
Tag container with :badge[Native child].
{% /callout %}

:::unregistered
{% callout %}
Nested tag container.
{% /callout %}
:::

{% if $visible %}
::unregistered[Native branch content]
{% else /%}
Tag branch with {% $name %}.
{% /if %}
`;
        const tree = parse(source, parseFirst);
        expect(tree.children).toMatchObject([
          {
            type: "paragraph",
            children: [
              { type: "textDirective" },
              { type: "text" },
              { type: "tagText" },
              { type: "text" },
            ],
          },
          { type: "leafDirective", name: "rule" },
          { type: "tagLeaf", name: "rule" },
          { type: "containerDirective", name: "callout" },
          { type: "tagContainer", name: "callout" },
          {
            type: "containerDirective",
            name: "unregistered",
            children: [{ type: "tagContainer" }],
          },
          {
            type: "tagConditional",
            children: [
              { type: "tagBranch", children: [{ type: "leafDirective" }] },
              { type: "tagBranch" },
            ],
          },
        ]);
        const original = structuredClone(tree);
        const output = write(tree, writeFirst);
        expect(output).toContain(":badge[Native badge]");
        expect(output).toContain('{% badge text="Tag badge" /%}');
        expect(output).toContain(":::callout");
        expect(output).toContain("{% callout %}");
        expect(meaning(parse(output, parseFirst))).toEqual(meaning(tree));
        expect(write(parse(output, parseFirst), writeFirst)).toBe(output);
        expect(tree).toEqual(original);
      },
    );

    test("handles tag children inside foreign inline nodes", () => {
      const source = ":tooltip[Native {% badge /%} and {% $name %}]";
      const tree = parse(source, parseFirst);
      expect(tree.children[0]).toMatchObject({
        type: "paragraph",
        children: [
          {
            type: "textDirective",
            children: [
              { type: "text", value: "Native " },
              { type: "tagText", name: "badge" },
              { type: "text", value: " and " },
              { type: "tagVariable", path: "name" },
            ],
          },
        ],
      });
      expect(meaning(parse(write(tree, parseFirst), parseFirst))).toEqual(meaning(tree));
    });

    test("keeps escaped tag openers literal in directive labels", () => {
      for (const prefix of [":", "::", ":::"]) {
        const source = `${prefix}tooltip[\\{% badge /%}]${prefix === ":::" ? "\n:::" : ""}`;
        const tree = parse(source, parseFirst);
        const output = write(tree, parseFirst);
        expect(meaning(parse(output, parseFirst)), output).toEqual(meaning(tree));
        expect(write(parse(output, parseFirst), parseFirst)).toBe(output);
      }
    });

    test.each([true, false])(
      "preserves edited tag attributes inside directive labels (tags write first: %s)",
      (writeFirst) => {
        for (const prefix of [":", "::", ":::"]) {
          for (const label of ["]", "[", "][", "[balanced]", String.raw`\[\]`, 'a "quote" [']) {
            const source = `${prefix}tooltip[{% badge text="safe" /%}]${prefix === ":::" ? "\n:::" : ""}`;
            const tree = parse(source, parseFirst);
            const first = tree.children[0];
            const directive = first.type === "paragraph" ? first.children[0] : first;
            if (
              directive.type !== "textDirective" &&
              directive.type !== "leafDirective" &&
              directive.type !== "containerDirective"
            )
              throw new Error("Expected directive");
            const child = directive.children[0];
            const tag = child.type === "paragraph" ? child.children[0] : child;
            if (tag.type !== "tagText") throw new Error("Expected tag");
            tag.attributes = { text: label };
            const original = structuredClone(tree);

            const output = write(tree, writeFirst);
            expect(meaning(parse(output, parseFirst)), `${prefix}: ${label}`).toEqual(
              meaning(tree),
            );
            expect(write(parse(output, parseFirst), writeFirst)).toBe(output);
            expect(tree).toEqual(original);
          }
        }
      },
    );
  },
);

test("a directive-only transform cannot select tags with the same name", () => {
  const tree = parse(':badge[Native] {% badge text="Tag" /%}', true);
  const paragraph = tree.children[0];
  if (paragraph.type !== "paragraph") throw new Error("Expected paragraph");
  for (const node of paragraph.children) {
    if (node.type === "textDirective" && node.name === "badge") {
      node.attributes = { title: "Changed by directive plugin" };
    }
  }
  expect(paragraph.children[2]).toMatchObject({
    type: "tagText",
    name: "badge",
    attributes: { text: "Tag" },
  });
  const output = write(tree, false);
  expect(output).toContain(':badge[Native]{title="Changed by directive plugin"}');
  expect(output).toContain('{% badge text="Tag" /%}');
});

// Install the native directive extensions as a plugin in a real unified pipeline.
function nativeDirectives(this: Processor): void {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(directive());
  (data.fromMarkdownExtensions ??= []).push(directiveFromMarkdown());
  (data.toMarkdownExtensions ??= []).push(directiveToMarkdown());
}

test.each([true, false])("composes remark plugins (tags first: %s)", (tagsFirst) => {
  const processor = unified().use(remarkParse);
  if (tagsFirst) processor.use(remarkTags, declarations, options).use(nativeDirectives);
  else processor.use(nativeDirectives).use(remarkTags, declarations, options);
  processor.use(remarkStringify);

  const source = ':badge[Native] {% badge text="Tag" /%}\n';
  const output = String(processor.processSync(source));
  expect(output).toBe(source);
  expect(String(processor.processSync(output))).toBe(output);
});
