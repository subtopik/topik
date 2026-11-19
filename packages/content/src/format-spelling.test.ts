import { expect, test } from "vite-plus/test";
import { formatTopikContent } from "./format.js";

function formatted(source: string): string {
  const result = formatTopikContent(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.formatted;
}

// Each expected output is what Prettier 3 and Oxfmt write for the same input and
// leave unchanged, so the two formatters agree.
test.each([
  ["a *b* c", "a _b_ c"],
  ["(*x*)", "(_x_)"],
  ["*`code`*", "_`code`_"],
  ["a*b*c", "a*b*c"],
  ["x *y*z", "x *y*z"],
  ["é*ü*é", "é*ü*é"],
  ["1*2*3", "1*2*3"],
  ["__strong__", "**strong**"],
  ["**a *b* c**", "**a _b_ c**"],
  ["*a __b__ c*", "_a **b** c_"],
  ["***x***", "_**x**_"],
  // Non-ASCII symbols count as word characters; ASCII ones as punctuation.
  ["€*100*", "€*100*"],
  ["🎉*x*", "🎉*x*"],
  ["$*x*", "$_x_"],
  ["+*x*", "+_x_"],
])("writes emphasis like Prettier: %s", (source, expected) => {
  expect(formatted(`${source}\n`)).toBe(`${expected}\n`);
});

test.each([
  ["a\n\n***\n\nb", "a\n\n---\n\nb"],
  ["- x\n\n  ---", "- x\n\n  ***"],
  ["1. x\n\n   ---", "1. x\n\n   ***"],
  ["- x\n- y\n\n\n* z\n\n  ***", "- x\n- y\n\n* z\n\n  ---"],
  ["> ***", "> ---"],
])("writes horizontal rules like Prettier: %j", (source, expected) => {
  expect(formatted(`${source}\n`)).toBe(`${expected}\n`);
});

test("a rule that opens the document stays apart from frontmatter", () => {
  // A leading `---` would open frontmatter and swallow the text after it.
  expect(formatted("***\n\ntext\n\n***\n")).toBe("***\n\ntext\n\n---\n");
  expect(formatted("---\ntitle: x\n---\n\n***\n\ntext\n")).toBe(
    "---\ntitle: x\n---\n\n---\n\ntext\n",
  );
});

test("a rule directly under a paragraph in a tight `*` item keeps `***`", () => {
  // `---` there would make the paragraph a heading, which Prettier writes.
  expect(formatted("- x\n\n* y\n  ***\n")).toBe("- x\n\n* y\n  ***\n");
  expect(formatted("- x\n\n* y\n\n  ***\n")).toBe("- x\n\n* y\n\n  ---\n");
});
