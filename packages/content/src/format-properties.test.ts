import { describe, expect, test } from "vite-plus/test";
import { compileTopikContent, formatTopikContent, validateTopikContent } from "./index.js";

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const INLINE = [
  "a",
  "b c",
  "[r]",
  "[r][]",
  "[x][r]",
  "[t](/p)",
  "<https://e.test>",
  "<a@b.test>",
  "<https://e.test/&amp;>",
  "*e*",
  "~~s~~",
  "`c`",
  "{% badge %}b{% /badge %}",
  '{% badge variant="info" /%}',
  "\\[",
  "[",
  "b]",
  "(",
  "2)",
  "\u000b",
  "&#x20;",
  "&#xb;",
  " ",
];
const METAS = ["", "js", "js &#x20;", "title &#x20; x", "js &#x9;a", "ts a&#x20;", "sh x"];

/** Random blocks built from the constructs whose combinations writers must keep apart. */
function generate(next: () => number): string {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
  const inline = (): string =>
    Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(INLINE)).join(
      pick(["", "", " ", "\n"]),
    );
  const indent = (lines: string[], first: string, rest: string) =>
    lines.map((line, index) => (index ? (line ? rest + line : rest.trimEnd()) : first + line));
  function block(depth: number): string[] {
    const choice = depth > 3 ? 0 : Math.floor(next() * 8);
    switch (choice) {
      case 1:
        return indent(blocks(depth + 1), "> ", "> ").map((line) =>
          line === "> " ? ">" : line.trimEnd(),
        );
      case 2: {
        const marker = pick(["- ", "* ", "1. ", "2) ", "3. "]);
        return indent(blocks(depth + 1), marker, " ".repeat(marker.length));
      }
      case 3: {
        const marker = pick(["- ", "1. ", "2) "]);
        // An empty item, or one whose content starts on the next line.
        return [marker.trimEnd(), ...indent(blocks(depth + 1), "", " ".repeat(marker.length))];
      }
      case 4:
        return ["```" + pick(METAS), ...pick([["x"], [], ["a", "", "b"]]), "```"];
      case 5:
        return ["{% callout %}", ...blocks(depth + 1), "{% /callout %}"];
      case 6:
        return ["| a | b |", "| - | - |", `| ${pick(INLINE)} | ${pick(INLINE)} |`];
      case 7:
        return [pick([">", "[r]: /u", "---", "# h"])];
      default:
        return inline().split("\n");
    }
  }
  function blocks(depth: number): string[] {
    const count = 1 + Math.floor(next() * 3);
    const lines: string[] = [];
    for (let index = 0; index < count; index++) {
      if (index) lines.push(...pick([[], [""]]));
      lines.push(...block(depth));
    }
    return lines;
  }
  return ["[r]: /u", "", ...blocks(0)].join("\n");
}

const variables = { config: { variables: {} } };

describe("formatting properties", () => {
  test("valid input is formattable, formatting is idempotent and does not change the compiled tree", () => {
    const next = random(20_261_114);
    let valid = 0;
    for (let iteration = 0; iteration < 200; iteration++) {
      const source = generate(next);
      if (!validateTopikContent(source).ok) continue;
      valid++;
      const formatted = formatTopikContent(source);
      expect({ source, diagnostics: formatted.ok ? [] : formatted.diagnostics }).toEqual({
        source,
        diagnostics: [],
      });
      if (!formatted.ok) continue;
      const again = formatTopikContent(formatted.formatted);
      expect({ source, again: again.ok ? again.formatted : again.diagnostics }).toEqual({
        source,
        again: formatted.formatted,
      });
      const before = compileTopikContent(source, variables);
      const after = compileTopikContent(formatted.formatted, variables);
      expect({ source, tree: after.ok ? after.tree : after.diagnostics }).toEqual({
        source,
        tree: before.ok ? before.tree : before.diagnostics,
      });
    }
    // Keep the generator honest: most documents it builds must be valid.
    expect(valid).toBeGreaterThan(100);
  }, 30_000);
});
