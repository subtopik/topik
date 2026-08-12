import { describe, expect, test } from "vite-plus/test";
import { formatTopikContent } from "./format";

describe("Topik content formatting", () => {
  test("canonical validation cannot be replaced before formatting", () => {
    const source = "{% quiz %}{% /quiz %}";
    const result = formatTopikContent(source, {
      config: { tags: { quiz: { render: "TopikQuiz" } } },
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("formatted");
  });

  test("refuses unsupported source without normalizing its exact spelling", () => {
    const source = '  {% mystery private="opaque" %}\r\nchild\r\n{% /mystery %}  ';
    const result = formatTopikContent(source);

    expect(result).toMatchObject({ ok: false, source });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "tag-undefined", level: "critical" })]),
    );
    expect(result).not.toHaveProperty("formatted");
  });

  test("formats valid source through a typed success result", () => {
    const source = "# Heading";
    const result = formatTopikContent(source);

    expect(result).toMatchObject({
      ok: true,
      source,
      diagnostics: [],
      formatted: "# Heading\n",
    });
  });

  test("keeps sensitive source and absolute paths out of refusal diagnostics", () => {
    const sentinel = "SENSITIVE_DIRECTORY";
    const source = "![x](é.png)";
    const result = formatTopikContent(source, { file: `/tmp/${sentinel}/lesson.md` });

    expect(result).toMatchObject({ ok: false, source });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", file: "lesson.md" }),
      ]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(sentinel);
    expect(JSON.stringify(result.diagnostics)).not.toContain("/tmp/");
  });

  test("does not expose invalid authored enum values through format refusal", () => {
    const sentinel = "PRIVATE_VALUE_SENTINEL";
    const source = `{% callout variant="${sentinel}" %}child{% /callout %}`;
    const result = formatTopikContent(source, {
      file: "C:\\SENSITIVE_DIRECTORY\\lesson.md",
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("formatted");
    expect(JSON.stringify(result.diagnostics)).not.toContain(sentinel);
    expect(JSON.stringify(result.diagnostics)).not.toContain("SENSITIVE_DIRECTORY");
    expect(JSON.stringify(result.diagnostics)).not.toContain(source);
  });
});
