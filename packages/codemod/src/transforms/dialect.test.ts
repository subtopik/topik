import { validateTopikContent } from "@topik/content";
import { describe, expect, test } from "vite-plus/test";
import { transformMintlify } from "./mintlify";

describe("codemod literal ranges in the Topik Markdown dialect", () => {
  test.each([
    ["table row", "| A | B |\n| - | - |\n| ` | x |\n| y | `<Note>literal</Note>` |\n"],
    ["table cell", "| A | B |\n| - | - |\n| ` | `<Note>literal</Note>` |\n"],
    ["table header", "| ` | B |\n| - | - |\n| y | `<Note>literal</Note>` |\n"],
    ["table escaped pipe", "| A | B |\n| - | - |\n| ` | x |\n| y | `<Note>\\|</Note>` |\n"],
    ["table double ticks", "| A | B |\n| - | - |\n| `` | x |\n| y | ``<Note>literal</Note>`` |\n"],
    ["table unsupported JSX", "| A | B |\n| - | - |\n| ` | x |\n| y | `<Icon />` |\n"],
    ["directive close", "{% callout %}\n` unmatched\n{% /callout %}\n`<Note>literal</Note>`\n"],
    ["directive open", "` unmatched\n{% callout %}\n`<Note>literal</Note>`\n{% /callout %}\n"],
    ["directive title", '{% callout title="`<Note>literal</Note>`" %}\nBody.\n{% /callout %}\n'],
    ["self-closing directive", '{% card title="`<Note>literal</Note>`" /%}\n'],
    ["inline directive", "Use {% badge %}`<Note>literal</Note>`{% /badge %}.\n"],
    ["math metadata", '{% math content="`<Note>literal</Note>`" /%}\n'],
    [
      "conditional branch",
      "{% if true %}\n` unmatched\n{% else /%}\n`<Note>literal</Note>`\n{% /if %}\n",
    ],
    ["task list", "- [ ] `<Note>literal</Note>` and `<Icon />`\n"],
    ["strikethrough", "~~`<Note>literal</Note>`~~ and ~~`<Icon />`~~\n"],
    [
      "code template",
      "{% template code %}\n```mdx\n<Note>literal</Note>\n```\n{% /template code %}\n",
    ],
    ["heading ID", "# `<Note>literal</Note>` {% #literal %}\n"],
  ])("preserves %s boundaries and migrates real JSX", (_name, literal) => {
    expect(validateTopikContent(literal).valid).toBe(true);
    expect(transformMintlify(literal)).toEqual({ content: literal, changed: false, warnings: [] });
    for (const eol of ["\n", "\r\n"]) {
      const metadata = `\uFEFF---${eol}title: Example${eol}---${eol}${eol}`;
      const retained = literal.replaceAll("\n", eol);
      for (const wrapped of [false, true]) {
        const source = `${metadata}${wrapped ? `<Note>${eol}${eol}` : ""}${retained}${eol}<Note>Actual.</Note>${eol}${wrapped ? `</Note>${eol}` : ""}`;
        const result = transformMintlify(source);
        expect(result.warnings).toEqual([]);
        expect(result.changed).toBe(true);
        expect(result.content.startsWith(metadata)).toBe(true);
        expect(result.content).toContain(retained);
        expect(result.content).toContain('variant="info" %}\nActual.\n{% /callout %}');
        expect(validateTopikContent(result.content).valid).toBe(true);
      }
    }
  });

  test("does not pair backticks across directive attributes and real JSX", () => {
    const source =
      '{% callout title="`" %}\n<Note>Real.</Note>\n{% /callout %}\n{% card title="`" /%}\n';
    expect(transformMintlify(source)).toEqual({
      content:
        '{% callout title="`" %}\n{% callout variant="info" %}\nReal.\n{% /callout %}\n{% /callout %}\n{% card title="`" /%}\n',
      changed: true,
      warnings: [],
    });
  });

  test("retains the existing refusal of unsupported footnotes", () => {
    const source =
      "Text[^a]\n\n[^a]: `<Note>literal</Note>` and `<Icon />`\n\n<Note>Real.</Note>\n";
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("not valid Topik content; source kept"),
      }),
    ]);
  });

  test("ends a JSX body before following inline code", () => {
    const source = "<Note>\n` unmatched\n</Note>\n`<Note>literal</Note>`\n";
    expect(transformMintlify(source)).toEqual({
      content:
        '{% callout variant="info" %}\n` unmatched\n{% /callout %}\n`<Note>literal</Note>`\n',
      changed: true,
      warnings: [],
    });
  });
});
