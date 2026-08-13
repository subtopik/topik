import Markdoc, { type Config } from "@markdoc/markdoc";
import { describe, expect, test, vi } from "vite-plus/test";
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

const ambiguousDiagnosticFiles = [
  " https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https%3A%2F%2Fuser%3AFILE_CREDENTIAL_SENTINEL%40example.com%2FSENSITIVE_DIRECTORY%2Flesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL",
  "https%253A%252F%252Fuser%253AFILE_CREDENTIAL_SENTINEL%2540example.com%252FSENSITIVE_DIRECTORY%252Flesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL",
  "/tmp/SENSITIVE_DIRECTORY%2Flesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL",
  String.raw`C:\SENSITIVE_DIRECTORY%5Clesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL`,
  String.raw`\\server\SENSITIVE_DIRECTORY%5Clesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL`,
  "https://example.com/SENSITIVE_DIRECTORY%2Flesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  "https://user:%46ILE_CREDENTIAL_SENTINEL@example.com/lesson.md",
  "https://user:%46ILE_CREDENTIAL_SENTINEL@[?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL",
  "https ://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&amp;colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&#58;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "\u0085/tmp/SENSITIVE_DIRECTORY/lesson.md",
  "\u200B/tmp/SENSITIVE_DIRECTORY/lesson.md",
  "\u202E/tmp/SENSITIVE_DIRECTORY/lesson.md",
] as const;

describe("Topik content formatting", () => {
  test.each(["constructor", null, ["String", "constructor"]] as const)(
    "refuses reviewed unsupported attribute type %# without formatting",
    (type) => {
      const source = "  {% notice value={x: 1} /%}\r\n![Asset](old.png)  ";
      const result = formatTopikContent(source, {
        config: {
          tags: {
            notice: {
              render: "span",
              selfClosing: true,
              attributes: { value: { type: type as never } },
            },
          },
        },
      });

      expect(result).toMatchObject({
        ok: false,
        source,
        diagnostics: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
      });
      expect(result).not.toHaveProperty("formatted");
    },
  );

  test.each(["constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "refuses an unregistered inherited tag %s without formatting",
    (name) => {
      const source = `  {% ${name} %}ordinary child{% /${name} %}  `;
      const result = formatTopikContent(source);

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("formatted");
      expect(JSON.stringify(result.diagnostics)).not.toContain("ordinary child");
    },
  );

  test.each([
    {
      source: "{% partial file=$which /%}",
      config: {
        variables: { which: "part.md" },
        partials: { "part.md": Markdoc.parse("Top-level child") },
      },
    },
    {
      source: "{% partial file=$selection.which /%}",
      config: {
        variables: { selection: { which: "part.md" } },
        partials: { "part.md": Markdoc.parse("Nested-path child") },
      },
    },
    {
      source: '{% partial file="outer.md" variables={which: "inner.md"} /%}',
      config: {
        partials: {
          "outer.md": Markdoc.parse("{% partial file=$which /%}"),
          "inner.md": Markdoc.parse("Scoped child"),
        },
      },
    },
  ])("formats valid variable-selected partial source", ({ config, source }) => {
    const result = formatTopikContent(source, { config });

    expect(result).toMatchObject({ ok: true, source });
    if (!result.ok) return;
    expect(result.formatted).toBe(`${source}\n`);
  });

  test.each([undefined, 42, "missing.md"])(
    "refuses an unresolved variable-selected partial without formatting",
    (which) => {
      const source = "  {% partial file=$which /%}  ";
      const result = formatTopikContent(source, {
        config: {
          variables: { which },
          partials: { "part.md": Markdoc.parse("Safe") },
        },
      });

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("formatted");
    },
  );

  test("refuses an invalid reachable partial without formatting or extension validation", () => {
    const source = '  {% partial file="bad.md" /%}  ';
    const extensionValidator = vi.fn(() => []);
    const result = formatTopikContent(source, {
      config: {
        partials: {
          "bad.md": Markdoc.parse("{% attack /%}\n{% quiz %}ordinary child{% /quiz %}"),
        },
        tags: { attack: { render: "div", validate: extensionValidator } },
      },
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("formatted");
    expect(JSON.stringify(result.diagnostics)).not.toContain("ordinary child");
    expect(extensionValidator).not.toHaveBeenCalled();
  });

  test.each([
    "http://example.com/file.pdf",
    "https://user:PRIVATE_VALUE_SENTINEL@example.com/file.pdf",
    `asset:auto-v1-${"a".repeat(52)}`,
  ])("refuses an unsafe partial link without formatting", (href) => {
    const source = '  {% partial file="part.md" /%}  ';
    const result = formatTopikContent(source, {
      config: { partials: { "part.md": Markdoc.parse(`[Download](${href})`) } },
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("formatted");
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  test("refuses canonical errors before an extension validator can enable formatting", () => {
    const source = "{% attack /%}\n{% quiz %}ordinary child{% /quiz %}";
    const extensionValidator = vi.fn((_node, config: Config) => {
      const quiz = config.tags?.quiz as Record<string, unknown>;
      Reflect.set(quiz, "validate", () => []);
      return [];
    });
    const result = formatTopikContent(source, {
      config: { tags: { attack: { render: "div", validate: extensionValidator } } },
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("formatted");
    expect(extensionValidator).not.toHaveBeenCalled();
  });

  test("refuses exact source when a reachable-partial instance validator retargets a sibling", () => {
    const source = '  {% partial file="attack.md" /%}\n![Asset](old.png)  ';
    const extensionValidator = vi.fn((_node, config: Config) => {
      const root = config.validation?.parents?.[0];
      const victim =
        root === undefined
          ? undefined
          : [root, ...root.walk()].find((node) => node.tag === "victim");
      if (victim !== undefined) victim.attributes.bad = false;
      return [];
    });
    class AttackType {
      validate = extensionValidator;
    }
    const result = formatTopikContent(source, {
      config: {
        partials: {
          "attack.md": Markdoc.parse('{% attack value="safe" /%}\n{% victim bad=true /%}'),
        },
        tags: {
          attack: {
            render: "span",
            selfClosing: true,
            attributes: { value: { type: AttackType } },
          },
          victim: {
            render: "span",
            selfClosing: true,
            attributes: {
              bad: {
                type: Boolean,
                required: true,
                matches: [false] as unknown as string[],
              },
            },
          },
        },
      },
    });

    expect(extensionValidator).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
    });
    expect(result).not.toHaveProperty("formatted");
  });

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

  test.each(ambiguousDiagnosticFiles)("fails an ambiguous format label closed", (file) => {
    const source = '{% callout variant="PRIVATE_VALUE_SENTINEL" /%}';
    const result = formatTopikContent(source, { file });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("formatted");
    expect(result.diagnostics).toEqual([expect.objectContaining({ file: "content" })]);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL|%2F|%25/iu,
    );
  });
});
