import { expect, test } from "vite-plus/test";
import { markdownFrontmatter } from "./frontmatter";
import { parseMarkdownFrontmatter } from "./shared";

test.each(["\n", "\r\n"])(
  "accepts fence whitespace with exact header boundaries using %j",
  (eol) => {
    for (const bom of ["", "\uFEFF"]) {
      for (const opening of ["", " ", "\t", " \t"]) {
        for (const closing of ["", " ", "\t", "\t "]) {
          for (const metadata of [
            "",
            "id: stable",
            "id: stable" + eol + "title: Authored Title # Café",
          ]) {
            for (const body of ["", eol + "# Heading" + eol]) {
              const prefix = `${bom}---${opening}${eol}`;
              const raw = `${prefix}${metadata}${metadata ? eol : ""}---${closing}${body}`;
              const content = body.slice(eol.length);
              const result = markdownFrontmatter(raw)!;
              expect(result).toEqual({
                frontmatter: metadata,
                content,
                start: prefix.length,
                end: prefix.length + metadata.length,
                bodyStart: raw.length - content.length,
              });
              expect(raw.slice(result.start, result.end)).toBe(metadata);
              expect(parseMarkdownFrontmatter(raw, "intro.md", 1).content).toBe(content);
            }
          }
        }
      }
    }
  },
);

test.each([
  " ---\nid: stable\n---\n",
  "--- text\nid: stable\n---\n",
  "---\nid: stable\n--- text\n",
  "---\nid: stable\n ---\n",
  "--- \nid: stable\n",
  "--- \n---\u00a0\n",
])("does not accept invalid or incomplete fences: %j", (raw) => {
  expect(markdownFrontmatter(raw)).toBeUndefined();
});
