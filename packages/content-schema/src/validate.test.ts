import Markdoc, { type Config, type Node } from "@markdoc/markdoc";
import { describe, expect, test, vi } from "vite-plus/test";
import { topikComponents } from "./components";
import { mergeTopikMarkdocConfig, topikMarkdocConfig } from "./config";
import { validateTopikContent } from "./validate";

function idsFor(source: string): string[] {
  return validateTopikContent(source).errors.map((error) => error.id);
}

function findTag(root: Node | undefined, tag: string): Node | undefined {
  return root === undefined ? undefined : [root, ...root.walk()].find((node) => node.tag === tag);
}

const unsafeDiagnosticFiles = [
  "/tmp/SENSITIVE_DIRECTORY/lesson.md",
  String.raw`C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\server\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Device\HarddiskVolume1\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\\user:FILE_CREDENTIAL_SENTINEL@server\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  "https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  "//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
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
] as const;

describe("topik content schema", () => {
  test("public config maps and nested schemas cannot mutate canonical validation authority", () => {
    const source = "{% quiz %}ordinary child{% /quiz %}";
    const publicConfig = topikMarkdocConfig as unknown as Record<string, unknown>;
    const publicTags = topikMarkdocConfig.tags as unknown as Record<string, unknown>;
    const publicQuiz = topikMarkdocConfig.tags.quiz as unknown as Record<string, unknown>;
    const originalTags = publicConfig.tags;
    const originalQuiz = publicTags.quiz;
    const originalValidate = publicQuiz.validate;

    try {
      const mutationResults = [
        Reflect.set(publicQuiz, "validate", () => []),
        Reflect.set(publicTags, "quiz", { render: "TopikQuiz", validate: () => [] }),
        Reflect.set(publicConfig, "tags", {
          quiz: { render: "TopikQuiz", validate: () => [] },
        }),
      ];

      expect(mutationResults).toEqual([false, false, false]);
      const result = validateTopikContent(source);
      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "topik-quiz-requires-question" })]),
      );
    } finally {
      Reflect.set(publicConfig, "tags", originalTags);
      Reflect.set(publicTags, "quiz", originalQuiz);
      Reflect.set(publicQuiz, "validate", originalValidate);
    }
  });

  test("merged config snapshots cannot mutate or replace canonical validation authority", () => {
    const source = "{% quiz %}ordinary child{% /quiz %}";
    const first = mergeTopikMarkdocConfig();
    const second = mergeTopikMarkdocConfig();
    const firstQuiz = first.tags?.quiz as Record<string, unknown>;

    expect(first.tags).not.toBe(topikMarkdocConfig.tags);
    expect(first.tags).not.toBe(second.tags);
    expect(firstQuiz).not.toBe(topikMarkdocConfig.tags.quiz);
    expect(firstQuiz).not.toBe(second.tags?.quiz);

    const originalValidate = firstQuiz.validate;
    try {
      expect(Reflect.set(firstQuiz, "validate", () => [])).toBe(true);
      expect(
        Reflect.set(first, "tags", { quiz: { render: "TopikQuiz", validate: () => [] } }),
      ).toBe(true);

      const result = validateTopikContent(source, { config: first });
      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "topik-quiz-requires-question" })]),
      );
    } finally {
      Reflect.set(firstQuiz, "validate", originalValidate);
    }
  });

  test("canonical validation cannot be replaced through normal configuration", () => {
    const source = "{% quiz %}{% /quiz %}";
    const result = validateTopikContent(source, {
      config: { tags: { quiz: { render: "TopikQuiz" } } },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "topik-quiz-requires-question" })]),
    );
  });

  test("rejects canonical errors before extension callbacks can mutate validation state", () => {
    const invalidQuiz = "{% attack /%}\n{% quiz %}ordinary child{% /quiz %}";
    const validQuiz = findTag(
      Markdoc.parse(`{% quiz %}
{% question type="single-choice" %}
{% choice correct=true %}Yes{% /choice %}
{% choice %}No{% /choice %}
{% /question %}
{% /quiz %}`),
      "quiz",
    );
    const cases: Array<{
      mutate: (node: Node, config: Config) => void;
      source: string;
    }> = [
      {
        source: invalidQuiz,
        mutate: (_node, config) => {
          const quiz = config.tags?.quiz as Record<string, unknown>;
          Reflect.set(quiz, "validate", () => []);
        },
      },
      {
        source: invalidQuiz,
        mutate: (_node, config) => {
          const quiz = findTag(config.validation?.parents?.[0], "quiz");
          if (quiz !== undefined) quiz.tag = "attack";
        },
      },
      {
        source: '{% attack /%}\n{% callout variant="PRIVATE_VALUE_SENTINEL" /%}',
        mutate: (_node, config) => {
          const callout = findTag(config.validation?.parents?.[0], "callout");
          if (callout !== undefined) callout.attributes.variant = "info";
        },
      },
      {
        source: invalidQuiz,
        mutate: (_node, config) => {
          const quiz = findTag(config.validation?.parents?.[0], "quiz");
          if (quiz !== undefined && validQuiz !== undefined) quiz.children = validQuiz.children;
        },
      },
      {
        source: "{% attack %}{% quiz %}ordinary child{% /quiz %}{% /attack %}",
        mutate: (node) => {
          const quiz = findTag(node, "quiz");
          if (quiz !== undefined) quiz.tag = "attack";
          node.attributes.changed = true;
          node.children = [];
        },
      },
    ];

    for (const { mutate, source } of cases) {
      const extensionValidator = vi.fn((node: Node, config: Config) => {
        mutate(node, config);
        return [];
      });
      const result = validateTopikContent(source, {
        config: { tags: { attack: { render: "div", validate: extensionValidator } } },
      });

      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: expect.stringMatching(/^(?:error|critical)$/u) }),
        ]),
      );
      expect(extensionValidator).not.toHaveBeenCalled();
    }
  });

  test("isolates caller and returned extension graphs from extension validation", () => {
    const source = '{% attack value="original" /%}';
    const attribute = { type: String };
    const schema = {
      render: "div",
      attributes: { value: attribute },
      validate: (_node: Node, config: Config) => {
        const effectiveAttack = config.tags?.attack as Record<string, unknown>;
        const effectiveAttributes = effectiveAttack.attributes as Record<string, unknown>;
        Reflect.set(effectiveAttack, "render", "mutated");
        Reflect.set(effectiveAttributes, "value", { type: Number });
        return [];
      },
    };
    const extension = { tags: { attack: schema } };
    const returned = mergeTopikMarkdocConfig(extension);

    expect(validateTopikContent(source, { config: returned })).toMatchObject({ valid: true });
    expect(schema.render).toBe("div");
    expect(schema.attributes.value).toBe(attribute);
    expect(returned.tags?.attack).toMatchObject({
      render: "div",
      attributes: { value: attribute },
    });
    expect(topikMarkdocConfig.tags.quiz).toHaveProperty("validate", expect.any(Function));
  });

  test("rejects canonical errors in the complete reachable partial closure before callbacks", () => {
    const source = '{% partial file="outer.md" /%}';
    const extensionValidator = vi.fn(() => []);
    const partials = {
      "outer.md": Markdoc.parse('{% partial file="inner.md" /%}'),
      "inner.md": Markdoc.parse("{% attack /%}\n{% quiz %}ordinary child{% /quiz %}", {
        file: "/tmp/SENSITIVE_DIRECTORY/inner.md",
      }),
    };

    const result = validateTopikContent(source, {
      config: {
        partials,
        tags: { attack: { render: "div", validate: extensionValidator } },
      },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "topik-quiz-requires-question",
          file: "inner.md",
        }),
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toMatch(
      /ordinary child|SENSITIVE_DIRECTORY|\/tmp\//u,
    );
    expect(extensionValidator).not.toHaveBeenCalled();
  });

  test("validates partial arrays once when their AST is shared by multiple names", () => {
    const source = ['{% partial file="first.md" /%}', '{% partial file="second.md" /%}'].join("\n");
    const invalid = Markdoc.parse("{% quiz %}ordinary child{% /quiz %}");
    const shared = [Markdoc.parse("# Safe"), invalid];
    const result = validateTopikContent(source, {
      config: { partials: { "first.md": shared, "second.md": shared } },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors.filter(({ id }) => id === "topik-quiz-requires-question")).toHaveLength(1);
  });

  test.each([
    {
      name: "a literal partial name",
      source: '{% partial file="asset.md" /%}',
      variables: {},
    },
    {
      name: "a variable-selected partial name",
      source: "{% partial file=$selection.which /%}",
      variables: { selection: { which: "asset.md" } },
    },
  ])(
    "applies canonical Asset policy throughout the partial closure for $name",
    ({ source, variables }) => {
      const partial = Markdoc.parse("![Asset](safe.png)", {
        file: "/tmp/SENSITIVE_DIRECTORY/asset.md",
      });
      const image = [partial, ...partial.walk()].find((node) => node.type === "image");
      if (image === undefined) throw new Error("Expected image fixture");
      image.attributes.src = "é.png";
      const result = validateTopikContent(source, {
        config: {
          variables,
          partials: {
            "asset.md": partial,
          },
        },
      });

      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", file: "asset.md" }),
        ]),
      );
      expect(JSON.stringify(result.errors)).not.toMatch(/é\.png|SENSITIVE_DIRECTORY|\/tmp\//u);
    },
  );

  test.each([
    {
      partials: (() => {
        const partials: Record<string, Node> = {};
        partials["self.md"] = Markdoc.parse('{% partial file="self.md" /%}');
        return partials;
      })(),
      source: '{% partial file="self.md" /%}',
      id: "topik-partial-cycle",
    },
    {
      partials: {
        "a.md": Markdoc.parse('{% partial file="b.md" /%}'),
        "b.md": Markdoc.parse('{% partial file="a.md" /%}'),
      },
      source: '{% partial file="a.md" /%}',
      id: "topik-partial-cycle",
    },
    {
      partials: { "bad.md": { private: "PRIVATE_VALUE_SENTINEL" } },
      source: '{% partial file="bad.md" /%}',
      id: "topik-partial-invalid",
    },
    {
      partials: { "bad.md": [Markdoc.parse("# Safe"), "PRIVATE_VALUE_SENTINEL"] },
      source: '{% partial file="bad.md" /%}',
      id: "topik-partial-invalid",
    },
    {
      partials: (() => {
        const root = Markdoc.parse("# Cyclic AST");
        root.children.push(root);
        return { "cycle.md": root };
      })(),
      source: '{% partial file="cycle.md" /%}',
      id: "topik-partial-cycle",
    },
    {
      partials: (() => {
        const roots: unknown[] = [];
        roots.push(roots);
        return { "cycle.md": roots };
      })(),
      source: '{% partial file="cycle.md" /%}',
      id: "topik-partial-invalid",
    },
  ])("fails a cyclic or malformed partial graph closed", ({ id, partials, source }) => {
    const result = validateTopikContent(source, { config: { partials } });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    expect(JSON.stringify(result.errors)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|self\.md|a\.md|b\.md|bad\.md|cycle\.md/u,
    );
  });

  test("clones partial AST graphs without changing valid partial and custom-function behavior", () => {
    const source = '{% partial file="safe.md" /%}';
    const partial = Markdoc.parse("{% callout title=label() %}Custom child{% /callout %}");
    const transform = vi.fn(() => "Safe title");
    const extension = {
      functions: { label: { returns: String, transform } },
      partials: { "safe.md": partial },
    };
    const first = mergeTopikMarkdocConfig(extension);
    const second = mergeTopikMarkdocConfig(extension);

    expect(first.partials?.["safe.md"]).not.toBe(partial);
    expect(first.partials?.["safe.md"]).not.toBe(second.partials?.["safe.md"]);
    expect(validateTopikContent(source, { config: extension })).toMatchObject({
      source,
      valid: true,
      errors: [],
    });
    expect(transform).not.toHaveBeenCalled();
  });

  test("ignores malformed partial graphs that are not reachable from the source", () => {
    const source = "# Safe";
    const result = validateTopikContent(source, {
      config: {
        partials: {
          "unused.md": { private: "PRIVATE_VALUE_SENTINEL" },
        },
      },
    });

    expect(result).toEqual({ source, valid: true, errors: [] });
  });

  test.each([
    {
      name: "a top-level variable",
      source: "{% partial file=$which /%}",
      config: {
        variables: { which: "part.md" },
        partials: { "part.md": Markdoc.parse("Top-level child") },
      },
    },
    {
      name: "a nested variable path",
      source: "{% partial file=$selection.which /%}",
      config: {
        variables: { selection: { which: "part.md" } },
        partials: { "part.md": Markdoc.parse("Nested-path child") },
      },
    },
    {
      name: "a partial-local literal variable",
      source: '{% partial file="outer.md" variables={which: "inner.md"} /%}',
      config: {
        partials: {
          "outer.md": Markdoc.parse("{% partial file=$which /%}"),
          "inner.md": Markdoc.parse("Scoped child"),
        },
      },
    },
    {
      name: "a partial-local variable resolved from global scope",
      source: '{% partial file="outer.md" variables={which: $target} /%}',
      config: {
        variables: { target: "inner.md" },
        partials: {
          "outer.md": Markdoc.parse("{% partial file=$which /%}"),
          "inner.md": Markdoc.parse("Scoped global child"),
        },
      },
    },
  ])("accepts a valid partial selected by $name", ({ config, source }) => {
    expect(validateTopikContent(source, { config })).toEqual({ source, valid: true, errors: [] });
  });

  test.each([
    { variables: {}, name: "missing variable" },
    { variables: { which: "missing.md" }, name: "missing target" },
    { variables: { which: 42 }, name: "non-string target" },
  ])("fails a variable-selected partial with a $name closed", ({ variables }) => {
    const source = "{% partial file=$which /%}";
    const result = validateTopikContent(source, {
      config: { variables, partials: { "part.md": Markdoc.parse("Safe") } },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: expect.stringMatching(/^(?:error|critical)$/u) }),
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toMatch(/missing\.md|which|42/u);
  });

  test("does not execute a function transform to select a partial", () => {
    const source = "{% partial file=select() /%}";
    const transform = vi.fn(() => "part.md");
    const result = validateTopikContent(source, {
      config: {
        functions: { select: { returns: String, transform } },
        partials: { "part.md": Markdoc.parse("Safe") },
      },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "topik-partial-invalid" })]),
    );
    expect(transform).not.toHaveBeenCalled();
  });

  test("applies the same invalid closure proof to a variable-selected partial", () => {
    const source = "{% partial file=$selection.which /%}";
    const result = validateTopikContent(source, {
      config: {
        variables: { selection: { which: "bad.md" } },
        partials: { "bad.md": Markdoc.parse("{% quiz %}ordinary child{% /quiz %}") },
      },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "topik-quiz-requires-question" })]),
    );
    expect(JSON.stringify(result.errors)).not.toMatch(/bad\.md|ordinary child/u);
  });

  test.each([
    {
      name: "cyclic closure",
      variables: { selection: { which: "self.md" } },
      partials: { "self.md": Markdoc.parse('{% partial file="self.md" /%}') },
      id: "topik-partial-cycle",
    },
    {
      name: "malformed entry",
      variables: { selection: { which: "bad.md" } },
      partials: { "bad.md": { private: "PRIVATE_VALUE_SENTINEL" } },
      id: "topik-partial-invalid",
    },
  ])("fails a variable-selected $name closed", ({ id, partials, variables }) => {
    const source = "{% partial file=$selection.which /%}";
    const result = validateTopikContent(source, { config: { partials, variables } });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    expect(JSON.stringify(result.errors)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|selection|self\.md|bad\.md/u,
    );
  });

  test("runs additive extension validation once after canonical acceptance", () => {
    const source = '{% notice tone="quiet" /%}';
    const extensionValidator = vi.fn(() => [
      {
        id: "extension-warning",
        level: "warning" as const,
        message: "PRIVATE_VALUE_SENTINEL",
      },
    ]);
    const result = validateTopikContent(source, {
      config: {
        tags: {
          notice: {
            render: "aside",
            attributes: { tone: { type: String, required: true } },
            validate: extensionValidator,
          },
        },
      },
    });

    expect(result).toMatchObject({ source, valid: true });
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: "extension-warning",
        level: "warning",
        message: "Content validation failed.",
      }),
    ]);
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
    expect(extensionValidator).toHaveBeenCalledOnce();
  });

  test("returns a sanitized blocking extension diagnostic after canonical acceptance", () => {
    const source = '{% notice tone="PRIVATE_VALUE_SENTINEL" /%}';
    const extensionValidator = vi.fn(() => [
      {
        id: "extension-invalid",
        level: "error" as const,
        message: "Rejected PRIVATE_VALUE_SENTINEL",
      },
    ]);
    const result = validateTopikContent(source, {
      config: {
        tags: {
          notice: {
            render: "aside",
            attributes: { tone: { type: String } },
            validate: extensionValidator,
          },
        },
      },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: "extension-invalid",
        level: "error",
        message: "Content validation failed.",
      }),
    ]);
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
    expect(extensionValidator).toHaveBeenCalledOnce();
  });

  test.each([
    '{% mystery private="opaque" %}\r\nchild\r\n{% /mystery %}',
    'Before {% mystery private="opaque" %}child{% /mystery %} after',
    '{% mystery private="outer" %}\n{% unknown private="inner" %}child{% /unknown %}\n{% /mystery %}',
  ])("retains the exact source when unsupported content is rejected", (source) => {
    const result = validateTopikContent(source);

    expect(result.source).toBe(source);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "tag-undefined", level: "critical" })]),
    );
  });

  test("keeps malformed external reference text out of serialized diagnostics", () => {
    const sentinel = "PRIVATE_VALUE";
    for (const reference of [
      `https://user:${sentinel}@[`,
      `https://user:%50RIVATE_VALUE@[`,
      `hTtPs://user:${sentinel}@[`,
      `https://example.com/?token=${sentinel}#%zz`,
    ]) {
      const result = validateTopikContent(`{% card title="Unsafe" href="${reference}" /%}`);
      expect(result.valid).toBe(false);
      expect(JSON.stringify(result.errors)).not.toContain(sentinel);
      expect(JSON.stringify(result.errors)).not.toContain(reference);
    }
  });

  test.each(unsafeDiagnosticFiles)(
    "normalizes every public Markdoc diagnostic surface for %s",
    (file) => {
      const sentinel = "PRIVATE_VALUE_SENTINEL";
      const source = `{% callout variant="${sentinel}" %}child{% /callout %}`;
      const result = validateTopikContent(source, { file });

      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "attribute-value-invalid",
            file: "lesson.md",
            message: expect.any(String),
          }),
        ]),
      );
      expect(result).not.toHaveProperty("markdocErrors");
      expect(JSON.stringify(result.errors)).not.toContain(sentinel);
      expect(JSON.stringify(result.errors)).not.toContain("SENSITIVE_DIRECTORY");
      expect(JSON.stringify(result.errors)).not.toContain(source);
      expect(JSON.stringify(result.errors)).not.toMatch(
        /FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u,
      );
    },
  );

  test.each(["lesson.md", "guides/lesson.md", String.raw`guides\lesson.md`])(
    "preserves safe relative diagnostic label %s",
    (file) => {
      const result = validateTopikContent('{% callout variant="invalid" /%}', { file });
      expect(result.errors[0]?.file).toBe(file);
    },
  );

  test.each(ambiguousDiagnosticFiles)("fails an ambiguous diagnostic label closed", (file) => {
    const source = '{% callout variant="PRIVATE_VALUE_SENTINEL" /%}';
    const result = validateTopikContent(source, { file });

    expect(result.errors).toEqual([
      expect.objectContaining({ file: "content", message: "An attribute has an invalid value." }),
    ]);
    expect(JSON.stringify(result.errors)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL|%2F|%25/iu,
    );
  });

  test("exports component metadata for the initial schema surface", () => {
    expect(Object.keys(topikComponents).sort()).toEqual([
      "accordion",
      "badge",
      "callout",
      "card",
      "cardGrid",
      "choice",
      "codeBlock",
      "codeGroup",
      "codeTab",
      "explanation",
      "figure",
      "image",
      "inlineCode",
      "link",
      "math",
      "mathInline",
      "mermaid",
      "question",
      "quiz",
      "step",
      "steps",
      "tab",
      "table",
      "tableCell",
      "tableHeader",
      "tableRow",
      "tabs",
      "underline",
    ]);
    expect(topikComponents.callout.attributes?.variant.values).toEqual([
      "info",
      "tip",
      "warning",
      "danger",
    ]);
    expect(topikComponents.cardGrid.attributes?.columns).toMatchObject({ min: 1, max: 4 });
    expect(topikComponents.figure.attributes?.darkSrc).toMatchObject({ type: "string" });
    expect(topikComponents.codeGroup.requiredChildren).toEqual(["codeTab"]);
    expect(topikComponents.math.attributes?.content).toMatchObject({ required: true });
    expect(topikComponents.quiz.allowedChildren).toEqual(["question"]);
  });

  test("validates a representative learning page", () => {
    const result = validateTopikContent(`
# Getting started

{% callout variant="tip" title="Before you start" %}
Read the setup instructions first.
{% /callout %}

{% cardGrid columns=2 %}
{% card title="Install" href="/install" %}
Install the package.
{% /card %}
{% card title="Configure" href="/configure" %}
Configure your first project.
{% /card %}
{% /cardGrid %}

{% tabs %}
{% tab title="pnpm" %}
\`\`\`sh
pnpm install
\`\`\`
{% /tab %}
{% tab title="npm" %}
\`\`\`sh
npm install
\`\`\`
{% /tab %}
{% /tabs %}

{% steps %}
{% step title="Create content" %}
Write your page.
{% /step %}
{% step title="Validate" %}
Run the validator.
{% /step %}
{% /steps %}

{% figure src="hero.png" darkSrc="hero-dark.png" alt="Course dashboard" caption="Dashboard overview" /%}

{% codeGroup %}
{% codeTab title="pnpm" %}
\`\`\`sh
pnpm install
\`\`\`
{% /codeTab %}
{% codeTab title="npm" %}
\`\`\`sh
npm install
\`\`\`
{% /codeTab %}
{% /codeGroup %}

{% math content="E = mc^2" /%}

Inline math: {% mathInline content="x^2" /%}

Use {% underline %}important text{% /underline %}.

\`\`\`mermaid
graph TD;
  A-->B;
\`\`\`

{% quiz %}
{% question %}
{% choice correct=true %}Topik content is Markdoc-based.{% /choice %}
{% choice %}Topik content is binary.{% /choice %}
{% explanation %}Topik content is authored as Markdown with Markdoc tags.{% /explanation %}
{% /question %}
{% /quiz %}
`);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("validates Markdoc attributes", () => {
    expect(idsFor('{% callout variant="surprise" /%}')).toContain("attribute-value-invalid");
    expect(idsFor('{% callout variant="note" /%}')).toContain("attribute-value-invalid");
    expect(idsFor('{% card href="/docs" /%}')).toContain("attribute-missing-required");
    expect(idsFor('{% figure src="image.png" /%}')).toContain("attribute-missing-required");
    expect(idsFor('{% figure src="image.png" darkSrc="image-dark.png" alt="Image" /%}')).toEqual(
      [],
    );
    expect(idsFor("{% math /%}")).toContain("attribute-missing-required");
    expect(idsFor("{% codeTab %}```ts\nconst x = 1;\n```{% /codeTab %}")).toContain(
      "attribute-missing-required",
    );
    expect(idsFor("{% cardGrid columns=5 /%}")).toContain("topik-columns-range");
    expect(idsFor("[Unsupported](ftp://example.com)")).toContain("link-scheme-unsupported");
    expect(idsFor('{% card title="Unsafe" href="data:text/plain,test" /%}')).toContain(
      "link-scheme-unsafe",
    );
  });

  test.each([
    "http://example.com/a.png",
    "https://user:secret@example.com/a.png",
    "file:///tmp/a.png",
    "data:image/png;base64,AA==",
    "blob:https://example.com/id",
    "javascript:alert(1)",
    "//example.com/a.png",
    "/absolute.png",
    "assets%2fhero.png",
    "é.png",
  ])("rejects unsafe or noncanonical asset reference %s", (reference) => {
    const result = validateTopikContent(`{% figure src="${reference}" alt="Unsafe reference" /%}`);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^TOPIK_(?:ASSET_PATH_INVALID|EXTERNAL_REFERENCE_UNSAFE)$/u),
          level: "error",
        }),
      ]),
    );
  });

  test("accepts canonical local and credential-free HTTPS asset references", () => {
    expect(
      validateTopikContent(
        '{% figure src="assets/caf%C3%A9.png" darkSrc="https://example.com/dark.png?q=1#x" alt="Hero" /%}',
      ),
    ).toMatchObject({ valid: true, errors: [] });
    expect(
      validateTopikContent(
        "![External image](https://example.com/image.png)\n\n[External file](https://example.com/file.pdf)\n",
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("accepts mixed-case credential-free HTTPS in every Asset-capable Markdown form", () => {
    expect(
      validateTopikContent(
        [
          "![Image](HtTpS://example.com/image.png)",
          "[Download](hTTps://example.com/manual.pdf)",
          "<HTTPS://example.com/autolink.pdf>",
          '{% figure src="HTtPs://example.com/light.png" darkSrc="htTPs://example.com/dark.png" alt="Theme" /%}',
        ].join("\n\n"),
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test.each(['"title (detail)"', "'title (detail)'", "(title detail)"])(
    "accepts image and possible-download references with Markdoc inline title form %s",
    (title) => {
      expect(
        validateTopikContent(`![Hero](hero.png ${title})\n\n[Manual](manual.bin ${title})\n`),
      ).toMatchObject({ valid: true, errors: [] });
    },
  );

  test.each([
    '"title \\"detail\\" (v1)"',
    `'title "detail" (v1)'`,
    `(title "detail" v1)`,
    `'title \\'detail\\' "quote"'`,
    `(title \\) detail "quote")`,
    '"title &quot;detail&quot; (v1)"',
    '"title\n&quot;detail&quot; (v1)"',
    '"title \\\\ path"',
    '"title &amp;quot; literal"',
  ])("accepts decoded quotation semantics in inline title form %s", (title) => {
    expect(
      validateTopikContent(`![Hero](hero.png ${title})\n\n[Manual](manual.bin ${title})\n`),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test.each([
    "[HTTP file](http://example.com/file.pdf)",
    "[Mixed HTTP](hTtP://example.com/file.pdf)",
    "<HTtp://example.com/file.pdf>",
    "[Credentialed HTTPS file](https://user:secret@example.com/file.pdf)",
    "<http://example.com/file.pdf>",
    "<https://user:secret@example.com/file.pdf>",
    "<person@example.com> <http://example.com/file.pdf>",
  ])("rejects unsafe HTTP policy in a possible download link: %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", type: "link.href" }),
      ]),
    });
  });

  test.each([
    "![Mixed HTTP](HtTp://example.com/image.png)",
    "![Mixed credentialed HTTPS](hTtPs://user:secret@example.com/image.png)",
    '{% figure src="HTtp://example.com/image.png" alt="Unsafe" /%}',
    '{% figure src="https://example.com/light.png" darkSrc="hTtPs://user:secret@example.com/dark.png" alt="Unsafe" /%}',
  ])("rejects unsafe mixed-case external media reference: %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE" }),
      ]),
    });
  });

  test("accepts a credential-free HTTPS autolink", () => {
    expect(validateTopikContent("<https://example.com/file.pdf>")).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test.each([
    ["http://example.com/file.pdf", "before"],
    ["http://example.com/file.pdf", "after"],
    ["https://user:secret@example.com/file.pdf", "before"],
    ["https://user:secret@example.com/file.pdf", "after"],
  ])(
    "rejects effective unsafe destination %s when a reference link appears %s",
    (reference, placement) => {
      const unavailable = "[Unavailable][id]";
      const parsed = `[Download](${reference})`;
      const paragraph =
        placement === "before" ? `${unavailable} ${parsed}` : `${parsed} ${unavailable}`;
      expect(validateTopikContent(`${paragraph}\n\n> [id]: ${reference}`)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", type: "link.href" }),
        ]),
      });
    },
  );

  test.each(["before", "after"])(
    "accepts effective credential-free HTTPS destinations when a reference link appears %s",
    (placement) => {
      const reference = "https://example.com/file.pdf";
      const unavailable = "[Unavailable][id]";
      const parsed = `[Download](${reference})`;
      const paragraph =
        placement === "before" ? `${unavailable} ${parsed}` : `${parsed} ${unavailable}`;
      expect(validateTopikContent(`${paragraph}\n\n> [id]: ${reference}`)).toMatchObject({
        valid: true,
        errors: [],
      });
    },
  );

  test.each([
    ["http://example.com/hero.png", false, "TOPIK_EXTERNAL_REFERENCE_UNSAFE"],
    ["https://user:secret@example.com/hero.png", false, "TOPIK_EXTERNAL_REFERENCE_UNSAFE"],
    ["https://example.com/hero.png", true, undefined],
    ["hero.png", false, "TOPIK_ASSET_PATH_INVALID"],
  ])(
    "applies exact-source and external policy to an unpaired effective image destination %s",
    (reference, valid, diagnosticId) => {
      const source = `![Unavailable][id] ![Hero](${reference})\n\n> [id]: ${reference}`;
      expect(validateTopikContent(source)).toMatchObject(
        valid
          ? { valid: true, errors: [] }
          : {
              valid: false,
              errors: expect.arrayContaining([
                expect.objectContaining({
                  id: diagnosticId,
                  type: "image.src",
                }),
              ]),
            },
      );
    },
  );

  test("rejects Asset references in authoring input and permits generated names for output consumers", () => {
    const generated = `auto-v1-${"a".repeat(52)}`;
    expect(
      validateTopikContent(`{% card title="Asset" href="asset:${generated}" /%}`),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "link-asset-navigation-unsupported" }),
      ]),
    });
    expect(validateTopikContent(`![Compiled](asset:${generated})\n`)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED" }),
      ]),
    });
    expect(
      validateTopikContent(`![Compiled](asset:${generated})\n`, {
        allowCompiledAssetReferences: true,
      }),
    ).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test("reports malformed reserved generated names with a typed diagnostic", () => {
    expect(validateTopikContent("![Hero](asset:auto-v1-short)\n")).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED", type: "image.src" }),
      ]),
    });
  });

  test.each([
    "asset:company-logo",
    "asset:auto-v1-short",
    "ASSET:company-logo",
    "asset%3Acompany-logo",
    "%61sset%3Acompany-logo",
    "asset%3Acompany%ZZ",
    "asset&#58;company-logo",
  ])("rejects reserved Asset link spelling %s with a typed diagnostic", (reference) => {
    expect(validateTopikContent(`[Download](${reference})\n`)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          id: "TOPIK_ASSET_REFERENCE_MALFORMED",
          type: "link.href",
        }),
      ]),
    });
  });

  test("rejects a raw non-ASCII reference-style image destination", () => {
    expect(validateTopikContent("![Hero][id]\n\n[id]: é.png\n")).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
    expect(
      validateTopikContent("![Good][good]\n\n[unused]: &eacute;.png\n[good]: good.png\n"),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("does not accept exact-source proof from an unrelated Markdoc attribute", () => {
    const source =
      '![x][id] {% callout title="![x](%C3%A9.png)" %}foo{% /callout %}\n\n> [id]: é.png';
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test.each([
    "![Hero](&eacute;.png)\n",
    "![Hero][id]\n\n[id]: &eacute;.png\n",
    "![Hero](hero\\.png)\n",
    "![Hero][id]\n\n[id]: hero\\.png\n",
  ])("rejects parser-unescaped source destination bytes in %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test.each([
    "![Nested [raw]](é.png)\n",
    "![Nested [entity]](&eacute;.png)\n",
    "![Nested [escaped]](hero\\.png)\n",
    "![Nested [reference]][id]\n\n[id]: é.png\n",
    "![Nested [reference]][id]\n\n[id]: &eacute;.png\n",
    "![Nested [reference]][id]\n\n[id]: hero\\.png\n",
    "[![Nested image](é.png)](manual.bin)\n",
  ])("rejects exact noncanonical destinations behind nested labels in %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test("accepts canonical encoded destinations behind nested labels", () => {
    expect(
      validateTopikContent(
        "![Inline [canonical]](%C3%A9.png)\n\n![Reference [canonical]][id]\n\n[id]: %C3%A9.png\n",
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test.each([
    "![Inline `]`](é.png)\n",
    "![Inline `[`](&eacute;.png)\n",
    "![Inline `]`](hero\\.png)\n",
    "![Reference `]`][id]\n\n[id]: é.png\n",
    "![Reference `[`][id]\n\n[id]: &eacute;.png\n",
    "![Reference `]`][id]\n\n[id]: hero\\.png\n",
  ])("rejects exact noncanonical destinations behind code-span labels in %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test("accepts canonical encoded destinations behind code-span labels", () => {
    expect(
      validateTopikContent(
        "![Inline `]`](%C3%A9.png)\n\n![Reference `[`][id]\n\n[id]: %C3%A9.png\n",
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("rejects a multiline external entity without borrowing a later escaped construct", () => {
    const source =
      "![Multiline](\n  https://example.com/a&amp;b\n) \\![fake](https://example.com/a&b)";
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", type: "image.src" }),
      ]),
    });
  });

  test("validates exact continuation-line definition destinations independently from titles", () => {
    for (const source of [
      "![Hero][id]\n\n[id]:\n  é.png\n",
      '![Hero][id]\n\n[id]:\n  &eacute;.png\n  "Title"\n',
    ]) {
      expect(validateTopikContent(source)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
        ]),
      });
    }
    expect(validateTopikContent('![Hero][id]\n\n[id]:\n  hero.png\n  "Title"\n')).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test("validates nested child structure", () => {
    expect(idsFor("{% cardGrid %}\n{% callout /%}\n{% /cardGrid %}")).toContain(
      "topik-card-grid-children",
    );
    expect(idsFor("{% tabs %}\nPlain paragraph\n{% /tabs %}")).toContain("topik-tabs-children");
    expect(idsFor("{% codeGroup %}\n{% callout /%}\n{% /codeGroup %}")).toContain(
      "topik-code-group-children",
    );
    expect(idsFor("{% codeGroup %}\n{% /codeGroup %}")).toContain(
      "topik-code-group-requires-code-tab",
    );
    expect(idsFor('{% codeGroup %}\n{% codeTab title="pnpm" /%}\n{% /codeGroup %}')).toContain(
      "topik-code-tab-requires-fence",
    );
    expect(idsFor("{% steps %}\n{% /steps %}")).toContain("topik-steps-requires-step");
    expect(idsFor("{% quiz %}\n{% /quiz %}")).toContain("topik-quiz-requires-question");
  });

  test("validates parent-only tags", () => {
    expect(idsFor('{% tab title="Standalone" /%}')).toContain("topik-tabs-parent-required");
    expect(idsFor('{% codeTab title="Standalone" /%}')).toContain(
      "topik-code-group-parent-required",
    );
    expect(idsFor('{% step title="Standalone" /%}')).toContain("topik-steps-parent-required");
    expect(idsFor("{% choice %}Standalone{% /choice %}")).toContain(
      "topik-question-parent-required",
    );
    expect(
      idsFor("{% question %}\n{% choice correct=true /%}\n{% choice /%}\n{% /question %}"),
    ).toContain("topik-quiz-parent-required");
  });

  test("validates quiz semantics", () => {
    expect(
      idsFor(
        "{% quiz %}\n{% question %}\n{% choice correct=true /%}\n{% /question %}\n{% /quiz %}",
      ),
    ).toContain("topik-question-choice-count");
    expect(
      idsFor(
        "{% quiz %}\n{% question %}\n{% choice /%}\n{% choice /%}\n{% /question %}\n{% /quiz %}",
      ),
    ).toContain("topik-question-single-correct-choice");
    expect(
      idsFor(
        "{% quiz %}\n{% question %}\n{% choice correct=true /%}\n{% choice correct=true /%}\n{% /question %}\n{% /quiz %}",
      ),
    ).toContain("topik-question-single-correct-choice");
    expect(
      idsFor(
        '{% quiz %}\n{% question type="multiple-choice" %}\n{% choice /%}\n{% choice /%}\n{% /question %}\n{% /quiz %}',
      ),
    ).toContain("topik-question-correct-choice-required");
  });

  test("includes parser file and line details in normalized diagnostics", () => {
    const result = validateTopikContent('{% card href="/docs" /%}', { file: "lesson.md" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ file: "lesson.md" });
    expect(result.errors[0].lines.length).toBeGreaterThan(0);
  });

  test("sanitizes absolute paths on manually constructed asset diagnostics", () => {
    const sentinel = "SENSITIVE_DIRECTORY";
    const source = "![x](é.png)";
    const result = validateTopikContent(source, { file: `/tmp/${sentinel}/lesson.md` });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", file: "lesson.md" }),
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toContain(sentinel);
    expect(JSON.stringify(result.errors)).not.toContain("/tmp/");
  });

  test("transforms tags to stable renderer component names", () => {
    const ast = Markdoc.parse('{% callout variant="warning" %}Careful{% /callout %}');
    const tree = Markdoc.transform(ast, topikMarkdocConfig);
    expect(JSON.stringify(tree)).toContain("TopikCallout");
    expect(JSON.stringify(tree)).toContain("warning");
  });

  test("transforms underline aliases to TopikUnderline", () => {
    const ast = Markdoc.parse("{% underline %}Important{% /underline %} and {% u %}short{% /u %}");
    const tree = Markdoc.transform(ast, topikMarkdocConfig);
    const rendered = JSON.stringify(tree);

    expect(rendered).toContain("TopikUnderline");
    expect(rendered).toContain("Important");
    expect(rendered).toContain("short");
  });

  test("transforms built-in markdown nodes to Topik renderer component names", () => {
    const ast = Markdoc.parse(`
[Docs](/docs)

![Hero](assets/hero.png)

\`\`\`ts
const answer = 42;
\`\`\`

| A | B |
| - | - |
| 1 | 2 |
`);
    const tree = Markdoc.transform(ast, topikMarkdocConfig);
    const rendered = JSON.stringify(tree);

    expect(rendered).toContain("TopikLink");
    expect(rendered).toContain("TopikImage");
    expect(rendered).toContain("TopikCodeBlock");
    expect(rendered).toContain("TopikTable");
    expect(rendered).toContain("TopikTableRow");
    expect(rendered).toContain("TopikTableCell");
    expect(rendered).toContain("TopikTableHeader");
  });

  test("transforms mermaid fences to TopikMermaid", () => {
    const ast = Markdoc.parse("```mermaid\ngraph TD;\n  A-->B;\n```");
    const tree = Markdoc.transform(ast, topikMarkdocConfig);
    const rendered = JSON.stringify(tree);

    expect(rendered).toContain("TopikMermaid");
    expect(rendered).toContain("graph TD");
  });
});
