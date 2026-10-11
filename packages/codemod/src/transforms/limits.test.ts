import { CONTENT_LIMITS } from "@topik/content";
import { describe, expect, test } from "vite-plus/test";
import { transformMintlify } from "./mintlify";

describe("codemod parser admission", () => {
  const unmatchedCode = Array.from({ length: 128 }, (_, index) => "`".repeat(index + 1) + " ").join(
    "",
  );

  test.each([
    ["source length", "x".repeat(CONTENT_LIMITS.sourceLength + 1), "source length"],
    ["unmatched code delimiters", unmatchedCode, "parser step"],
    ["nested quotes", "> ".repeat(CONTENT_LIMITS.treeDepth + 1) + "Text.", "tree depth"],
    ["nested emphasis", "*_".repeat(5_000) + "Text." + "_*".repeat(5_000), "parser step"],
    ["wide tree", "* * *\n\n".repeat(CONTENT_LIMITS.treeNodes + 1), "tree node"],
  ])("refuses excessive %s before scanning tags", (_name, source, limit) => {
    for (const original of [source, `<Note>\n${source}\n</Note>\n`]) {
      const result = transformMintlify(original);
      expect(result).toMatchObject({ content: original, changed: false });
      expect(result.warnings).toEqual([
        { line: 1, column: 1, message: expect.stringContaining(`${limit} limit`) },
      ]);
    }
  });

  test("weights delimiters at their original offsets after CRLF and frontmatter", () => {
    const source = `\uFEFF---\r\ntitle: Example\r\n---\r\n\r\n<Note>\r\n${unmatchedCode}\r\n</Note>\r\n`;
    expect(transformMintlify(source)).toEqual({
      content: source,
      changed: false,
      warnings: [{ line: 1, column: 1, message: expect.stringContaining("parser step limit") }],
    });
  });

  test.each([
    ["fenced code", `~~~mdx\n${unmatchedCode.repeat(20)}\n<Note>literal</Note>\n~~~`],
    ["inline code", "`" + "*_[]!~ ".repeat(20_000) + "`"],
  ])("keeps large %s payloads opaque to the parser budget", (_name, literal) => {
    const source = `<Note>\n${literal}\n</Note>\n`;
    expect(transformMintlify(source)).toEqual({
      content: `{% callout variant="info" %}\n${literal}\n{% /callout %}\n`,
      changed: true,
      warnings: [],
    });
  });
});
