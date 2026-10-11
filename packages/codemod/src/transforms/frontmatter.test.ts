import { parseTopikContent } from "@topik/content";
import { describe, expect, test } from "vite-plus/test";
import { frontmatterEnd } from "./frontmatter";

function expectCanonicalEnd(source: string, expected: number): void {
  const first = parseTopikContent(source).children[0];
  // Micromark strips one leading BOM before assigning source offsets.
  const canonicalEnd =
    first?.type === "yaml"
      ? first.position!.end.offset! + (source.startsWith("\uFEFF") ? 1 : 0)
      : 0;
  expect(canonicalEnd).toBe(expected);
  expect(frontmatterEnd(source)).toBe(canonicalEnd);
}

describe("frontmatter source boundary", () => {
  test.each(["\n", "\r\n", "\r"])("matches canonical offsets with %j line endings", (eol) => {
    for (const bom of ["", "\uFEFF"]) {
      for (const space of ["", " ", "\t", " \t "]) {
        for (const payload of ["", `title: Metadata${eol}`]) {
          const header = `${bom}---${space}${eol}${payload}---${space}`;
          expectCanonicalEnd(header, header.length);
          expectCanonicalEnd(`${header}${eol}Body${eol}`, header.length);
        }
      }
    }
  });

  test("matches mixed line endings and stops at the first complete closing fence", () => {
    const header = "\uFEFF--- \t\r\ntitle: Metadata\r---\t";
    expectCanonicalEnd(`${header}\nBody\r\n---\nmore: body\n---`, header.length);
  });

  test.each([
    "",
    "---",
    "--- \t",
    "---\n",
    "---\ntitle: No closing fence\n",
    " ---\ntitle: Indented opening\n---",
    "\t---\ntitle: Indented opening\n---",
    "----\ntitle: Extra hyphen\n---",
    "--- # comment\ntitle: Opening comment\n---",
    "---\u00A0\ntitle: Non-ASCII space\n---",
    "---\ntitle: Indented closing\n ---",
    "---\ntitle: Indented closing\n\t---",
    "---\ntitle: Extra hyphen\n----",
    "---\ntitle: Closing comment\n--- # comment",
    "---\ntitle: Non-ASCII space\n---\u00A0",
    "---\ntitle: Other YAML terminator\n...",
    "\n---\ntitle: Not the first line\n---",
    "\uFEFF\uFEFF---\ntitle: Two BOMs\n---",
    " \uFEFF---\ntitle: Misplaced BOM\n---",
    "---\ntitle: Closing BOM\n\uFEFF---",
  ])("does not invent a header for %j", (source) => {
    expectCanonicalEnd(source, 0);
  });

  test("keeps invalid closing candidates in the header until a valid delimiter", () => {
    const header = "---\n ---\n----\n--- # comment\n...\n\uFEFF---\n---\t ";
    expectCanonicalEnd(`${header}\nBody`, header.length);
  });
});
