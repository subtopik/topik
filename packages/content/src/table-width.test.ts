import { expect, test } from "vite-plus/test";
import { formatTopikContent } from "./format.js";

function formatted(source: string): string {
  const result = formatTopikContent(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.formatted;
}

test("table columns are padded by display width", () => {
  // An emoji or CJK character takes two columns in an editor, one combining
  // mark none, so the pipes line up in source as they do in Prettier's output.
  expect(
    formatted("| Status | Note |\n|---|---|\n| ✅ | done |\n| 👩🏽‍💻 | dev |\n| 中文 | é |\n"),
  ).toBe(
    [
      "| Status | Note |",
      "| ------ | ---- |",
      "| ✅     | done |",
      "| 👩🏽‍💻     | dev  |",
      "| 中文   | é    |",
      "",
    ].join("\n"),
  );
});

test("formatting a table with wide characters is stable", () => {
  const once = formatted("| 🎉 | x |\n|:-:|--:|\n| a | 中 |\n");
  expect(formatted(once)).toBe(once);
});
