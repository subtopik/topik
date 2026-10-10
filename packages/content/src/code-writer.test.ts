import type { Code, Root } from "mdast";
import { toMarkdown, type Options } from "mdast-util-to-markdown";
import { describe, expect, it, vi } from "vite-plus/test";
import { CONTENT_LIMITS, ContentLimitError } from "./limits.js";
import { codeWriterExtension } from "./code-writer.js";
import { evaluateDocument } from "./evaluate.js";
import { parseDocument } from "./markdown.js";

const unsafe: Options = {
  unsafe: [{ character: "{", after: "%", notInConstruct: "autolink" }],
};

function serialize(code: Code, bounded = true, fence: "`" | "~" = "`"): string {
  const root: Root = { type: "root", children: [code] };
  return toMarkdown(root, {
    fences: true,
    fence,
    extensions: bounded ? [unsafe, codeWriterExtension()] : [unsafe],
  });
}

function withLinearMembershipBudget<T>(size: number, action: () => T): T {
  const includes = Array.prototype.includes;
  let work = 0;
  const spy = vi.spyOn(Array.prototype, "includes").mockImplementation(function (
    this: unknown[],
    item: unknown,
    fromIndex?: number,
  ) {
    work += this.length;
    if (work > size * 20) throw new Error("Serialization exceeded a linear membership budget");
    return includes.call(this, item, fromIndex);
  });
  try {
    return action();
  } finally {
    spy.mockRestore();
  }
}

describe("ordinary code writer", () => {
  it.each(["`", "~"] as const)("retains canonical %s fences and header escaping", (fence) => {
    const alphabet = [
      "`",
      "~",
      "\\",
      "{",
      "%",
      "&",
      "#",
      ">",
      "[",
      "]",
      " ",
      "\t",
      "\n",
      "1",
      ".",
      "!",
      "<",
      ";",
      "a",
    ];
    let seed = 17;
    for (let index = 0; index < 1000; index++) {
      let header = "";
      for (let count = 0; count < index % 19; count++) {
        seed = (seed * 48271) % 2147483647;
        header += alphabet[seed % alphabet.length];
      }
      const code: Code = {
        type: "code",
        value: "``\n~~",
        lang: index % 2 ? "text" : header,
        meta: index % 2 ? header : undefined,
      };
      expect(serialize(code, true, fence)).toBe(serialize(code, false, fence));
    }
  });

  it.each(["payload", "metadata"])("bounds work for long backtick %s", (location) => {
    const size = 20_000;
    const ticks = "`".repeat(size);
    const code: Code = {
      type: "code",
      value: location === "payload" ? ticks : "example",
      lang: "text",
      meta: location === "metadata" ? ticks : undefined,
    };
    const result = withLinearMembershipBudget(size, () => serialize(code));
    if (location === "payload") {
      expect(result.indexOf("text\n")).toBe(size + 1);
      expect(result).toContain(`\n${ticks}\n`);
    } else {
      expect(result).toContain("&#x60;".repeat(size));
    }
  });

  it("refuses fence expansion before allocating an over-limit ordinary block", () => {
    const code: Code = { type: "code", value: "`".repeat(340_000) };
    const repeat = vi.spyOn(String.prototype, "repeat");
    try {
      expect(() => serialize(code)).toThrow(ContentLimitError);
      expect(repeat.mock.calls.some(([count]) => count > 3)).toBe(false);
    } finally {
      repeat.mockRestore();
    }
  });

  it("refuses encoded-header expansion without quadratic work or oversized emission", () => {
    const size = Math.floor(CONTENT_LIMITS.sourceLength / 6) + 1;
    const code: Code = { type: "code", value: "example", lang: "text", meta: "`".repeat(size) };
    expect(() => withLinearMembershipBudget(size, () => serialize(code))).toThrow(
      ContentLimitError,
    );
  });

  it("uses the bounded writer when proving a resolved code template is writable", () => {
    const source = "{% template code %}\n```text\n{% $value %}\n```\n{% /template code %}";
    const parsed = parseDocument(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("Expected supported template source");
    const size = 20_000;
    const value = "`".repeat(size);
    const resolved = withLinearMembershipBudget(size, () =>
      evaluateDocument(parsed.document, { value }),
    );

    expect(resolved.children[0]).toMatchObject({ type: "code", value, lang: "text" });
    expect(parsed.document.children[0].type).toBe("topikCodeTemplate");
  });
});
