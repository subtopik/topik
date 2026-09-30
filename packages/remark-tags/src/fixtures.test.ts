import { readFileSync, readdirSync } from "node:fs";
import type { Root } from "mdast";
import { expect, test } from "vite-plus/test";
import type { TagDiagnostic } from "./index.js";
import { meaning, parse, write } from "./test-support.js";

const base = new URL("../test/fixtures/", import.meta.url);
const fixtures = readdirSync(base, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

// Expected trees and Markdown are independent fixtures, never generated here.
for (const name of fixtures) {
  const directory = new URL(`${name}/`, base);
  const read = (file: string) => readFileSync(new URL(file, directory), "utf8");
  const input = read("input.md");
  if (readdirSync(directory).includes("diagnostics.json")) {
    test(`${name}: reports the expected diagnostics`, () => {
      const expected = JSON.parse(read("diagnostics.json")) as TagDiagnostic[];
      expect(() => parse(input)).toThrowError(
        expect.objectContaining({ name: "TagSyntaxError", diagnostics: expected }),
      );
    });
  } else {
    test(`${name}: parses and writes the specified tree without semantic loss`, () => {
      const expected = JSON.parse(read("tree.json")) as Root;
      const output = read("output.md");
      expect(meaning(parse(input))).toEqual(expected);
      expect(write(expected)).toBe(output);
      expect(meaning(parse(output))).toEqual(expected);
      expect(write(parse(output))).toBe(output);
    });
  }
}
