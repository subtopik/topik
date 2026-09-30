import { expect, test } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkTags, { remarkTags as namedRemarkTags, TagSyntaxError } from "./index.js";
import { processor } from "./test-support.js";

test("exposes the remark plugin as both default and named exports", () => {
  expect(remarkTags).toBe(namedRemarkTags);
  const process = unified()
    .use(remarkParse)
    .use(remarkTags, { hint: { kind: "inline" } })
    .use(remarkStringify);
  const source = "Read {% hint %}**help**{% /hint %}.\n";
  expect(String(process.processSync(source))).toBe(source);
});

test("preserves installed GFM extensions through a complete remark pipeline", () => {
  const source = '| Status |\n| --- |\n| {% badge label="A\\|B" /%} |\n';
  const process = processor();
  const output = String(process.processSync(source));
  expect(output).toContain('label="A\\|B"');
  expect(String(process.processSync(output))).toBe(output);
  expect(process.parse(output).children[0].type).toBe("table");
});

test("propagates syntax diagnostics through remark", async () => {
  await expect(processor().process("Before\n{% missing /%}")).rejects.toMatchObject({
    name: TagSyntaxError.name,
    diagnostics: [{ message: "Unknown tag missing", line: 2, column: 1 }],
  });
});
