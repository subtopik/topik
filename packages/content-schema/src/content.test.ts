import { describe, expect, test } from "vite-plus/test";
import { mergeTopikMarkdocConfig } from "./config";
import { formatTopikContent } from "./format";

const unsafeDiagnosticFiles = [
  "/tmp/SENSITIVE_DIRECTORY/lesson.md",
  String.raw`C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\server\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Device\HarddiskVolume1\SENSITIVE_DIRECTORY\lesson.md`,
  "https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
] as const;

describe("Topik content formatting", () => {
  test("mutated merged schemas cannot weaken validation before formatting", () => {
    const source = "{% quiz %}ordinary child{% /quiz %}";
    const config = mergeTopikMarkdocConfig();
    const quiz = config.tags?.quiz as Record<string, unknown>;
    const originalValidate = quiz.validate;

    try {
      Reflect.set(quiz, "validate", () => []);
      Reflect.set(config, "tags", { quiz: { render: "TopikQuiz", validate: () => [] } });

      const result = formatTopikContent(source, { config });

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("formatted");
    } finally {
      Reflect.set(quiz, "validate", originalValidate);
    }
  });

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

  test.each(unsafeDiagnosticFiles)("sanitizes format-refusal file label %s", (file) => {
    const source = '{% callout variant="PRIVATE_VALUE_SENTINEL" %}child{% /callout %}';
    const result = formatTopikContent(source, { file });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("formatted");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ file: "lesson.md", message: "An attribute has an invalid value." }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u,
    );
  });
});
