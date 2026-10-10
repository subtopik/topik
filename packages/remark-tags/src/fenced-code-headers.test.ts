import { describe, expect, test } from "vitest";
import type { Node } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { tagSyntax, tagFromMarkdown, tagToMarkdown } from "./index.js";

describe("host-owned raw fence metadata", () => {
  test("captures raw ordinary fence headers without adding node fields", () => {
    const headers = new WeakMap<Node, string>();
    const options = { fencedCodeHeaders: headers };
    const tree = fromMarkdown('~~~ts title="&amp; \\"quoted\\""\nvalue\n~~~', {
      extensions: [tagSyntax({}, options)],
      mdastExtensions: [tagFromMarkdown({}, options)],
    });
    expect(headers.get(tree.children[0])).toBe('ts title="&amp; \\"quoted\\""');
    expect(tree.children[0]).toMatchObject({
      type: "code",
      lang: "ts",
      meta: 'title="& "quoted""',
    });
    expect(Object.keys(tree.children[0])).toEqual(["type", "lang", "meta", "value", "position"]);
  });

  test("transfers fenced provenance to template leaves and delegates their header admission", () => {
    const headers = new WeakMap<Node, string>();
    const options = { expressions: true, fencedCodeHeaders: headers };
    const source =
      '{% template code %}\n~~~filename="foo&#32;bar" lines\nvalue {% $name %}\n~~~\n{% /template code %}';
    const tree = fromMarkdown(source, {
      extensions: [tagSyntax({}, options)],
      mdastExtensions: [tagFromMarkdown({}, options)],
    });
    expect(headers.get(tree.children[0])).toBe('filename="foo&#32;bar" lines');
    expect(tree.children[0]).toMatchObject({
      type: "tagCodeTemplate",
      template: {
        segments: [
          { type: "literal", value: "value " },
          { type: "variable", path: ["name"] },
        ],
      },
    });
    expect(tree.children[0]).not.toHaveProperty("rawHeader");
    expect(() =>
      fromMarkdown(source, {
        extensions: [tagSyntax({}, { expressions: true })],
        mdastExtensions: [tagFromMarkdown({}, { expressions: true })],
      }),
    ).toThrow("Code template language and metadata must fit one fence header");
  });

  test.each(["lines", "wrap", "filename", "title=literal"])(
    "protects literal template language %j when writing",
    (lang) => {
      const tree = {
        type: "root" as const,
        children: [
          {
            type: "tagCodeTemplate" as const,
            lang,
            template: {
              type: "topikTextTemplate" as const,
              segments: [{ type: "literal" as const, value: "value" }],
            },
          },
        ],
      };
      const options = { expressions: true };
      const written = toMarkdown(tree, { extensions: [tagToMarkdown({}, options)] });
      expect(written).toContain(`&#${lang.charCodeAt(0)};${lang.slice(1)}`);
      expect(
        fromMarkdown(written, {
          extensions: [tagSyntax({}, options)],
          mdastExtensions: [tagFromMarkdown({}, options)],
        }).children[0],
      ).toMatchObject({ type: "tagCodeTemplate", lang });
    },
  );

  test.each(["lines", "wrap=false", 'filename="literal.ts"', "title missing"])(
    "protects opaque template metadata %j when writing",
    (meta) => {
      const tree = {
        type: "root" as const,
        children: [
          {
            type: "tagCodeTemplate" as const,
            lang: "text",
            meta,
            template: { type: "topikTextTemplate" as const, segments: [] },
          },
        ],
      };
      const options = { expressions: true };
      const written = toMarkdown(tree, { extensions: [tagToMarkdown({}, options)] });
      expect(written).toContain(`&#${meta.charCodeAt(0)};${meta.slice(1)}`);
      expect(
        fromMarkdown(written, {
          extensions: [tagSyntax({}, options)],
          mdastExtensions: [tagFromMarkdown({}, options)],
        }).children[0],
      ).toMatchObject({ type: "tagCodeTemplate", meta });
    },
  );
});
