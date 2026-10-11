import { validateTopikContent } from "@topik/content";
import { describe, expect, test } from "vite-plus/test";
import { transformMintlify } from "./mintlify";

describe("Markdown contexts in JSX bodies", () => {
  const flows = [
    ["closing boundary", "<Note>\nUse a single ` as a delimiter.\n</Note>\n`example`\n"],
    ["opening boundary", "Use a single ` as a delimiter.\n<Note>\n`example`\n</Note>\n"],
    ["paired boundaries", "Use a ` as delimiter.\n<Note>\nActual.\n</Note>\n`example`\n"],
    ["double backticks", "<Note>\nUse `` as delimiter.\n</Note>\n``example``\n"],
    ["same-line body", "<Note>Use a single ` as a delimiter.\n</Note>\n`example`\n"],
    [
      "adjacent headers",
      '<Tabs><Tab title="Example">\nUse a ` as delimiter.\n</Tab></Tabs>\n`example`\n',
    ],
    ["self-closing card", 'Use a ` as delimiter.\n<Card title="Example" />\n`example`\n'],
    ["multiline attributes", 'Use a ` as delimiter.\n<Card\n title="` >"\n/>\n`example`\n'],
    [
      "definition after opener",
      '<Note>\n[ref]: ./intro "![first"\nUse a ` as delimiter.\n</Note>\nlast](image.png)\n`example`\n',
    ],
    [
      "indented code after opener",
      "<Note>\n    ![first\nUse a ` as delimiter.\n</Note>\nlast](image.png)\n`example`\n",
    ],
    ["completed literal before opener", "`![first`\n<Note>\nActual.\n</Note>\nlast](image.png)\n"],
  ];

  test.each(flows)("recognizes %s", (_name, body) => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      for (const prefix of ["", `\uFEFF---${eol}title: Example${eol}---${eol}${eol}`]) {
        const result = transformMintlify(prefix + body.replaceAll("\n", eol));
        expect(result.warnings).toEqual([]);
        expect(result.changed).toBe(true);
        expect(result.content.startsWith(prefix)).toBe(true);
        if (body.includes("`example`")) expect(result.content).toContain("`example`");
        expect(result.content).not.toContain("<Note>");
        expect(validateTopikContent(result.content).valid).toBe(true);
      }
    }
  });

  test.each(["", " ", "  ", "   ", "> ", "- ", "> - "])(
    "uses parser flow positions with prefix %j",
    (prefix) => {
      const continuation = prefix.replaceAll("-", " ");
      const body = `${prefix}<Note>\n${continuation}Use a single \` as delimiter.\n${continuation}</Note>\n\n\`example\`\n`;
      const result = transformMintlify(body);
      expect(result.warnings).toEqual([]);
      expect(result.changed).toBe(true);
      expect(result.content).toContain("`example`");
      expect(validateTopikContent(result.content).valid).toBe(true);
    },
  );

  test.each(["`", "``"])("retains genuine multiline %s literals", (ticks) => {
    const literal = `Use ${ticks}first\ntext <Note>example</Note> and <Icon />\nlast${ticks}.\n`;
    for (const source of [
      literal,
      `<Note>${literal}</Note>\n`,
      `${literal}\n<Note>Actual.</Note>\n`,
    ]) {
      const result = transformMintlify(source);
      expect(result).toMatchObject({ content: source, changed: false });
      expect(result.warnings).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("not valid Topik content; source kept"),
        }),
      ]);
    }
  });

  test.each([
    '[Docs](./intro "first\ntext <Note>literal</Note>\nlast")',
    "![first\ntext <Note>literal</Note>\nlast](image.png)",
    '[ref]: ./intro "first\ntext <Note>literal</Note>\nlast"\n\n[Docs][ref]',
  ])("preserves multiline resource metadata: %s", (resource) => {
    const result = transformMintlify(`<Note>\n${resource}\n</Note>\n`);
    expect(result).toEqual({
      content: `{% callout variant="info" %}\n${resource}\n{% /callout %}\n`,
      changed: true,
      warnings: [],
    });
  });

  test("retains autolinks and opaque indented component examples", () => {
    const body =
      "<https://example.com> and <user@example.com>\n\n    <Note>\n    literal\n    </Note>\n";
    expect(transformMintlify(`<Note>\n${body}</Note>\n`)).toEqual({
      content: `{% callout variant="info" %}\n${body}{% /callout %}\n`,
      changed: true,
      warnings: [],
    });
  });

  test.each([1, 2, 3])("preserves literals after %i leading BOMs", (count) => {
    for (const literal of [
      "```mdx\n<Note>literal</Note>\n```",
      "`<Note>literal</Note>`",
      "![<Note>literal</Note>](image.png)",
    ]) {
      const prefix = `${"\uFEFF".repeat(count)}---\n${literal}\n---\n`;
      const result = transformMintlify(`${prefix}<Note>Actual.</Note>\n`);
      expect(result.warnings).toEqual([]);
      expect(result.changed).toBe(true);
      expect(result.content).toBe(
        `${prefix}{% callout variant="info" %}\nActual.\n{% /callout %}\n`,
      );
    }
  });
});
