import { describe, expect, test } from "vite-plus/test";
import { formatDocument } from "./index.js";

describe("content syntax", () => {
  test("formatting refuses unsupported expressions with raw source", () => {
    const source = "{% $name + 1 %}";
    const result = formatDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("formatted");
  });

  test("formats literals safely", () => {
    const result = formatDocument("Keep \\*literal\\* text.");
    expect(result).toMatchObject({
      ok: true,
      source: "Keep \\*literal\\* text.",
      formatted: "Keep \\*literal\\* text.\n",
      document: {
        children: [
          { type: "paragraph", children: [{ type: "text", value: "Keep *literal* text." }] },
        ],
      },
    });
  });
});
