import { describe, expect, test } from "vite-plus/test";
import { parseTopikContent } from "./content.js";
import { formatTopikContent } from "./format.js";
import { assignTopikHeadingIds } from "./headings.js";
import { transformTopikContent } from "./render.js";
import { representativeDiagnosticFiles } from "./test-fixtures/diagnostic-files.js";
describe("Topik content formatting", () => {
  test("refuses unsupported source without normalizing its exact spelling", () => {
    const source = '  {% mystery private="opaque" %}\r\nchild\r\n{% /mystery %}  ';
    const result = formatTopikContent(source);

    expect(result).toMatchObject({ ok: false, source });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "tag-undefined", level: "critical" })]),
    );
    expect(result).not.toHaveProperty("formatted");
  });

  test("formats valid source through a typed success result", () => {
    const source = "# Heading";
    const result = formatTopikContent(source);

    expect(result).toMatchObject({
      ok: true,
      source,
      diagnostics: [],
      formatted: "# Heading\n",
    });
  });

  test.each([
    [
      "portable Markdown",
      [
        "---",
        "title: Metadata only",
        "---",
        "# Caf&eacute; and Unicode",
        "",
        "[Guide](/guide) and ![Logo](assets/logo.png)",
        "",
        "- First",
        "- [x] Literal task marker",
        "",
        "3. Third",
        "4. Fourth",
        "",
        "Hard break  ",
        "continues here.",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| Unicode | café |",
      ].join("\n"),
    ],
    [
      "Topik learning components",
      [
        '{% callout variant="tip" title="Remember" %}',
        "Use the helper.",
        "{% /callout %}",
        "",
        "{% tabs %}",
        '{% tab title="CLI" %}',
        "{% codeGroup %}",
        '{% codeTab title="npm" %}',
        "```sh",
        "npm install",
        "```",
        "{% /codeTab %}",
        "{% /codeGroup %}",
        "{% /tab %}",
        "{% /tabs %}",
        "",
        '{% accordion title="Details" %}',
        "More detail.",
        "{% /accordion %}",
        "",
        "{% steps %}",
        '{% step title="Install" %}',
        "Run it.",
        "{% /step %}",
        "{% /steps %}",
        "",
        'Inline {% badge variant="success" %}stable{% /badge %} and {% mathInline content="x^2" /%}.',
        "",
        '{% math content="E = mc^2" /%}',
        "",
        "```mermaid",
        "graph TD; A-->B;",
        "```",
        "",
        '{% figure src="assets/hero.png" alt="Hero" caption="Overview" /%}',
        "",
        '{% card title="Next" href="/next" /%}',
        "",
        "{% quiz %}",
        "{% question %}",
        "{% choice correct=true %}\nYes\n{% /choice %}",
        "{% choice %}\nNo\n{% /choice %}",
        "{% explanation %}\nBecause.\n{% /explanation %}",
        "{% /question %}",
        "{% /quiz %}",
      ].join("\n"),
    ],
  ])("preserves normalized %s semantics across repeated formatting", (_name, source) => {
    const first = formatTopikContent(source);

    expect(first).toMatchObject({ ok: true, source, diagnostics: [] });
    if (!first.ok) return;
    const second = formatTopikContent(first.formatted);
    expect(second).toMatchObject({ ok: true, source: first.formatted, diagnostics: [] });
    if (!second.ok) return;

    expect(contentSemantics(first.formatted)).toEqual(contentSemantics(source));
    expect(second.formatted).toBe(first.formatted);
  });

  test("keeps sensitive source and absolute paths out of refusal diagnostics", () => {
    const sentinel = "SENSITIVE_DIRECTORY";
    const source = "![x](é.png)";
    const result = formatTopikContent(source, { file: `/tmp/${sentinel}/lesson.md` });

    expect(result).toMatchObject({ ok: false, source });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", file: "lesson.md" }),
      ]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(sentinel);
    expect(JSON.stringify(result.diagnostics)).not.toContain("/tmp/");
  });

  test("does not expose invalid authored enum values through format refusal", () => {
    const sentinel = "PRIVATE_VALUE_SENTINEL";
    const source = `{% callout variant="${sentinel}" %}\nchild\n{% /callout %}`;
    const result = formatTopikContent(source, {
      file: "C:\\SENSITIVE_DIRECTORY\\lesson.md",
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("formatted");
    expect(JSON.stringify(result.diagnostics)).not.toContain(sentinel);
    expect(JSON.stringify(result.diagnostics)).not.toContain("SENSITIVE_DIRECTORY");
    expect(JSON.stringify(result.diagnostics)).not.toContain(source);
  });

  test.each(representativeDiagnosticFiles)(
    "sanitizes format-refusal file label %s",
    (file, label) => {
      const source = '{% callout variant="PRIVATE_VALUE_SENTINEL" %}\nchild\n{% /callout %}';
      const result = formatTopikContent(source, { file });

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("formatted");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ file: label, message: "An attribute has an invalid value." }),
      ]);
      expect(JSON.stringify(result.diagnostics)).not.toMatch(
        /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL|%2F|%25/iu,
      );
    },
  );
});

function contentSemantics(source: string): unknown {
  const ast = parseTopikContent(source);
  assignTopikHeadingIds(ast);
  return JSON.parse(JSON.stringify(transformTopikContent(ast))) as unknown;
}
