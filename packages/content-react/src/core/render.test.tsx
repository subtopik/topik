import Markdoc, { type Config } from "@markdoc/markdoc";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  formatTopikContent,
  mergeTopikMarkdocConfig,
  rewriteTopikAssetOccurrences,
  validateTopikContent,
} from "@topik/content-schema";
import { TopikContentProvider, useTopikComponents } from "./context";
import { getTopikComponents } from "./components";
import {
  compileTopikContent,
  InvalidTopikContentError,
  renderTopikContent,
  renderTopikMarkdown,
  renderTrustedTopikTree,
  resolveTopikAssetReferences,
} from "./render";

const allComponentsContent = `
# Lesson

{% callout variant="tip" title="Remember" %}
Use the helper.
{% /callout %}

{% cardGrid columns=2 %}
{% card title="One" href="/one" icon="1" %}
First card.
{% /card %}
{% /cardGrid %}

{% accordion title="Details" open=true %}
Hidden text.
{% /accordion %}

{% tabs %}
{% tab title="A" %}
Panel A.
{% /tab %}
{% tab title="B" %}
Panel B.
{% /tab %}
{% /tabs %}

{% steps %}
{% step title="Install" %}
Run it.
{% /step %}
{% /steps %}

{% figure src="assets/hero.png" darkSrc="assets/hero-dark.png" alt="Hero" caption="A figure" /%}

Inline {% badge variant="success" %}stable{% /badge %}.

![Logo](assets/logo.png)

{% codeGroup %}
{% codeTab title="pnpm" %}
\`\`\`sh
pnpm install
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

| A | B |
| - | - |
| 1 | 2 |

{% quiz %}
{% question type="single-choice" %}
{% choice correct=true %}
Yes.
{% /choice %}
{% choice %}
No.
{% /choice %}
{% explanation %}
Because it is correct.
{% /explanation %}
{% /question %}
{% /quiz %}
`;

const unsafeDiagnosticFiles = [
  "/tmp/SENSITIVE_DIRECTORY/lesson.md",
  String.raw`C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\server\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Device\HarddiskVolume1\SENSITIVE_DIRECTORY\lesson.md`,
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
  "https ://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&amp;colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&#58;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "\u0085/tmp/SENSITIVE_DIRECTORY/lesson.md",
  "\u200B/tmp/SENSITIVE_DIRECTORY/lesson.md",
  "\u202E/tmp/SENSITIVE_DIRECTORY/lesson.md",
] as const;

describe("content-react core", () => {
  it.each([
    {
      source: "{% partial file=$which /%}",
      config: {
        variables: { which: "part.md" },
        partials: { "part.md": Markdoc.parse("Top-level child") },
      },
      child: "Top-level child",
    },
    {
      source: "{% partial file=$selection.which /%}",
      config: {
        variables: { selection: { which: "part.md" } },
        partials: { "part.md": Markdoc.parse("Nested-path child") },
      },
      child: "Nested-path child",
    },
    {
      source: '{% partial file="outer.md" variables={which: "inner.md"} /%}',
      config: {
        partials: {
          "outer.md": Markdoc.parse("{% partial file=$which /%}"),
          "inner.md": Markdoc.parse("Scoped child"),
        },
      },
      child: "Scoped child",
    },
    {
      source: '{% partial file="outer.md" variables={which: $target} /%}',
      config: {
        variables: { target: "inner.md" },
        partials: {
          "outer.md": Markdoc.parse("{% partial file=$which /%}"),
          "inner.md": Markdoc.parse("Scoped global child"),
        },
      },
      child: "Scoped global child",
    },
  ])("compiles and renders valid variable-selected partial source", ({ child, config, source }) => {
    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
    expect(renderToStaticMarkup(renderTopikContent(result))).toContain(child);
    expect(renderToStaticMarkup(renderTopikMarkdown(source, { config }))).toContain(child);
  });

  it.each([undefined, 42, "missing.md"])(
    "refuses an unresolved variable-selected partial before render",
    (which) => {
      const source = "{% partial file=$which /%}";
      const config = {
        variables: { which },
        partials: { "part.md": Markdoc.parse("must not render") },
      };
      const transform = vi.spyOn(Markdoc, "transform");
      const result = compileTopikContent(source, { config });

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("tree");
      expect(() => renderTopikMarkdown(source, { config })).toThrow(InvalidTopikContentError);
      expect(transform).not.toHaveBeenCalled();
      transform.mockRestore();
    },
  );

  it("keeps variable-selected partials stable across callback-controlled phases", () => {
    const source = "{% attack /%}\n{% partial file=$which /%}";
    const safe = Markdoc.parse("Safe selected child");
    const bad = Markdoc.parse("{% quiz %}ordinary child{% /quiz %}");
    const config = {
      variables: { which: "safe.md" },
      partials: { "bad.md": bad, "safe.md": safe },
      tags: {
        attack: {
          render: "div",
          validate: (_node: unknown, effective: Config) => {
            config.variables.which = "bad.md";
            if (effective.variables && typeof effective.variables !== "function") {
              effective.variables.which = "bad.md";
            }
            return [];
          },
        },
      },
    };

    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
    const html = renderToStaticMarkup(renderTopikContent(result));
    expect(html).toContain("Safe selected child");
    expect(html).not.toContain("ordinary child");
  });

  it("removes custom-prototype variable aliases between validation and transform", () => {
    class Selection {
      which = "safe.md";
    }
    const source = "{% attack /%}\n{% partial file=$selection.which /%}";
    const selection = new Selection();
    const config = {
      variables: { selection },
      partials: {
        "safe.md": Markdoc.parse("Safe selected child"),
        "bad.md": Markdoc.parse("{% quiz %}ordinary child{% /quiz %}"),
      },
      tags: {
        attack: {
          render: "span",
          validate: (_node: unknown, effective: Config) => {
            const variables = effective.variables as Record<string, unknown>;
            (variables.selection as Selection).which = "bad.md";
            return [];
          },
        },
      },
    };

    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
    expect(selection.which).toBe("safe.md");
    const html = renderToStaticMarkup(renderTopikContent(result));
    expect(html).toContain("Safe selected child");
    expect(html).not.toContain("ordinary child");
  });

  it("isolates transform-function retargeting from validated partial selection", () => {
    const source = "{% callout title=retarget() /%}\n{% partial file=$which /%}";
    const transform = vi.fn((_parameters: unknown, effective: Config) => {
      if (effective.variables && typeof effective.variables !== "function") {
        effective.variables.which = "bad.md";
      }
      return "Safe title";
    });
    const config = {
      variables: { which: "safe.md" },
      partials: {
        "safe.md": Markdoc.parse("Safe selected child"),
        "bad.md": Markdoc.parse("{% quiz %}ordinary child{% /quiz %}"),
      },
      functions: { retarget: { returns: String, transform } },
    };

    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
    expect(transform).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(renderTopikContent(result));
    expect(html).toContain("Safe selected child");
    expect(html).not.toContain("ordinary child");
    expect(config.variables.which).toBe("safe.md");
  });

  it("keeps canonical browser-reference identity stable across transform callbacks", () => {
    const source = '{% callout title=retarget() /%}\n{% card title="Card" href=$unsafe /%}';
    const received: unknown[] = [];
    const transform = vi.fn((_parameters: unknown, effective: Config) => {
      const card = effective.tags?.card as Record<string, unknown>;
      card.render = "a";
      return "Safe title";
    });
    const result = compileTopikContent(source, {
      config: {
        variables: { unsafe: "data:text/html,PRIVATE_VALUE_SENTINEL" },
        functions: { retarget: { returns: String, transform } },
      },
    });

    expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
    expect(() =>
      renderToStaticMarkup(
        renderTopikContent(result, {
          components: {
            TopikCard: (props) => {
              received.push(props.href);
              return <span>Card</span>;
            },
          },
        }),
      ),
    ).not.toThrow();
    expect(received).toEqual([undefined]);
  });

  it("converts transform callback exceptions to a tree-free typed failure", () => {
    const source = "{% callout title=explode() /%}";
    const diagnostics: unknown[] = [];
    const result = compileTopikContent(source, {
      config: {
        functions: {
          explode: {
            returns: String,
            transform: () => {
              throw new Error("PRIVATE_VALUE_SENTINEL");
            },
          },
        },
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [
        expect.objectContaining({
          id: "topik-transform-failed",
          message: "Content transformation failed.",
        }),
      ],
    });
    expect(result).not.toHaveProperty("tree");
    expect(JSON.stringify([result.diagnostics, diagnostics])).not.toContain(
      "PRIVATE_VALUE_SENTINEL",
    );
    expect(() => renderTopikContent(result)).toThrow(InvalidTopikContentError);
  });

  it.each(["constructor", "__proto__", "toString"])(
    "renders explicitly own-registered inherited tag and function %s without contamination",
    (name) => {
      const tags = Object.create(null) as NonNullable<Config["tags"]>;
      const functions = Object.create(null) as NonNullable<Config["functions"]>;
      tags[name] = { render: "span", selfClosing: true };
      functions[name] = { returns: String, transform: () => "Safe title" };
      const source = `{% ${name} /%}\n{% callout title=${name}() /%}`;
      const result = compileTopikContent(source, { config: { functions, tags } });

      expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
      const html = renderToStaticMarkup(renderTopikContent(result));
      expect(html).toContain("<span></span>");
    },
  );

  it.each(["constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "refuses unregistered inherited construct %s across compile and render",
    (name) => {
      const source = `{% ${name} %}ordinary child{% /${name} %}`;
      const result = compileTopikContent(source);

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("tree");
      expect(() => renderTopikMarkdown(source)).toThrow(InvalidTopikContentError);
      expect(JSON.stringify(result.diagnostics)).not.toContain("ordinary child");
    },
  );

  it.each([
    "http://example.com/file.pdf",
    "https://user:PRIVATE_VALUE_SENTINEL@example.com/file.pdf",
    "https://[PRIVATE_VALUE_SENTINEL",
  ])("refuses unsafe link %s in a reachable partial before rendering", (href) => {
    const source = '{% partial file="part.md" /%}';
    const config = { partials: { "part.md": Markdoc.parse(`[Download](${href})`) } };
    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("tree");
    expect(() => renderTopikMarkdown(source, { config })).toThrow(InvalidTopikContentError);
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  it("allows a generated partial link only at the compiler output boundary", () => {
    const generated = `asset:auto-v1-${"a".repeat(52)}`;
    const source = '{% partial file="part.md" /%}';
    const result = compileTopikContent(source, {
      config: { partials: { "part.md": Markdoc.parse(`[Download](${generated})`) } },
    });

    expect(result).toMatchObject({ ok: true, source });
    const html = renderToStaticMarkup(renderTopikContent(result));
    expect(html).not.toContain(generated);
  });

  it("refuses invalid reachable partials before validation, transform, or rendering", () => {
    const source = '{% partial file="bad.md" /%}';
    const extensionValidator = vi.fn(() => []);
    const extensionTransform = vi.fn(() => new Markdoc.Tag("div", {}, ["must not render"]));
    const renderQuiz = vi.fn(() => <span>must not render</span>);
    const config = {
      partials: {
        "bad.md": Markdoc.parse("{% attack /%}\n{% quiz %}ordinary child{% /quiz %}"),
      },
      tags: {
        attack: {
          render: "div",
          validate: extensionValidator,
          transform: extensionTransform,
        },
      },
    };
    const transform = vi.spyOn(Markdoc, "transform");

    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("tree");
    expect(() => renderTopikContent(result)).toThrow(InvalidTopikContentError);
    expect(() => renderTopikMarkdown(source, { config })).toThrow(InvalidTopikContentError);
    expect(() =>
      renderTopikMarkdown(source, { components: { TopikQuiz: renderQuiz }, config }),
    ).toThrow(InvalidTopikContentError);
    const placeholder = renderToStaticMarkup(
      renderTopikMarkdown(source, { config, invalidContent: "placeholder" }),
    );
    expect(placeholder).toContain('role="alert"');
    expect(placeholder).not.toContain("ordinary child");
    expect(extensionValidator).not.toHaveBeenCalled();
    expect(extensionTransform).not.toHaveBeenCalled();
    expect(renderQuiz).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
    transform.mockRestore();
  });

  it.each(["root", "partial"] as const)(
    "refuses unsupported runtime attribute types across the %s source boundary",
    (boundary) => {
      const invalidTag =
        "{% notice value={x: 1} %}ordinary child that must not render{% /notice %}";
      const source =
        boundary === "root"
          ? `  ${invalidTag}\r\n![Asset](old.png)  `
          : '  {% partial file="invalid.md" /%}\r\n![Asset](old.png)  ';
      const renderUnsafeNotice = vi.fn(() => <span>ordinary child that must not render</span>);
      const config = {
        ...(boundary === "partial"
          ? { partials: { "invalid.md": Markdoc.parse(invalidTag) } }
          : {}),
        tags: {
          notice: {
            render: "TopikCallout",
            attributes: {
              value: {
                type:
                  boundary === "root"
                    ? ("constructor" as never)
                    : (["String", "constructor"] as never),
              },
            },
          },
        },
      };
      const replace = vi.fn(() => "new.png");
      const transform = vi.spyOn(Markdoc, "transform");

      try {
        const validation = validateTopikContent(source, { config });
        const compilation = compileTopikContent(source, { config });
        const formatting = formatTopikContent(source, { config });
        const rewriting = rewriteTopikAssetOccurrences(source, replace, { config });

        expect(validation).toMatchObject({
          source,
          valid: false,
          errors: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
        });
        expect(compilation).toMatchObject({
          ok: false,
          source,
          diagnostics: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
        });
        expect(compilation).not.toHaveProperty("tree");
        expect(formatting).toMatchObject({ ok: false, source });
        expect(formatting).not.toHaveProperty("formatted");
        expect(rewriting).toMatchObject({ ok: false, source });
        expect(rewriting).not.toHaveProperty("content");
        expect(replace).not.toHaveBeenCalled();
        expect(() => renderTopikContent(compilation)).toThrow(InvalidTopikContentError);
        expect(() => renderToString(renderTopikMarkdown(source, { config }))).toThrow(
          InvalidTopikContentError,
        );
        expect(() =>
          renderToString(
            renderTopikMarkdown(source, {
              components: { TopikCallout: renderUnsafeNotice },
              config,
            }),
          ),
        ).toThrow(InvalidTopikContentError);
        const placeholder = renderToStaticMarkup(
          renderTopikMarkdown(source, { config, invalidContent: "placeholder" }),
        );
        expect(placeholder).toContain('role="alert"');
        expect(placeholder).not.toContain("ordinary child");
        expect(placeholder).not.toContain("old.png");
        expect(renderUnsafeNotice).not.toHaveBeenCalled();
        expect(transform).not.toHaveBeenCalled();
      } finally {
        transform.mockRestore();
      }
    },
  );

  it("refuses a reachable-partial instance validator before compile or rendering", () => {
    const partial = Markdoc.parse(
      ['{% attack value="safe" /%}', "{% victim bad=true %}ordinary child{% /victim %}"].join("\n"),
    );
    const source = ['{% partial file="attack.md" /%}', "![Asset](old.png)"].join("\n");
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
    const extensionTransform = vi.fn(() => new Markdoc.Tag("span", {}, ["must not render"]));
    const renderVictim = vi.fn(() => <span>must not render</span>);
    const config = {
      partials: { "attack.md": partial },
      tags: {
        attack: {
          render: "span",
          selfClosing: true,
          transform: extensionTransform,
          attributes: { value: { type: AttackType } },
        },
        victim: {
          render: "TopikCallout",
          attributes: {
            bad: {
              type: Boolean,
              required: true,
              matches: [false] as unknown as string[],
            },
          },
        },
      },
    };
    const transform = vi.spyOn(Markdoc, "transform");
    const replace = vi.fn(() => "new.png");

    try {
      const validation = validateTopikContent(source, { config });
      const result = compileTopikContent(source, { config });
      const formatting = formatTopikContent(source, { config });
      const rewriting = rewriteTopikAssetOccurrences(source, replace, { config });

      expect(validation).toMatchObject({
        source,
        valid: false,
        errors: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
      });
      expect(result).toMatchObject({
        ok: false,
        source,
        diagnostics: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
      });
      expect(result).not.toHaveProperty("tree");
      expect(formatting).toMatchObject({ ok: false, source });
      expect(formatting).not.toHaveProperty("formatted");
      expect(rewriting).toMatchObject({ ok: false, source });
      expect(rewriting).not.toHaveProperty("content");
      expect(replace).not.toHaveBeenCalled();
      expect(() => renderTopikContent(result)).toThrow(InvalidTopikContentError);
      expect(() => renderTopikMarkdown(source, { config })).toThrow(InvalidTopikContentError);
      expect(() =>
        renderTopikMarkdown(source, { components: { TopikCallout: renderVictim }, config }),
      ).toThrow(InvalidTopikContentError);
      const placeholder = renderToStaticMarkup(
        renderTopikMarkdown(source, { config, invalidContent: "placeholder" }),
      );
      expect(placeholder).toContain('role="alert"');
      expect(placeholder).not.toContain("ordinary child");
      expect(placeholder).not.toContain("old.png");
      expect(extensionValidator).not.toHaveBeenCalled();
      expect(extensionTransform).not.toHaveBeenCalled();
      expect(renderVictim).not.toHaveBeenCalled();
      expect(transform).not.toHaveBeenCalled();
    } finally {
      transform.mockRestore();
    }
  });

  it("rejects an instance-field transform before it can retarget partial selection", () => {
    const source = "{% attack value=$input /%}\n{% partial file=$which /%}";
    const retarget = vi.fn((value: unknown, config: Config) => {
      if (config.variables !== undefined) config.variables.which = "retargeted.md";
      return value as string;
    });
    class AttackType {
      transform = retarget;
    }
    const config = {
      variables: { input: "safe", which: "safe.md" },
      partials: {
        "safe.md": Markdoc.parse("Safe child"),
        "retargeted.md": Markdoc.parse("retargeted child"),
      },
      tags: {
        attack: {
          render: "span",
          selfClosing: true,
          attributes: { value: { type: AttackType } },
        },
      },
    };

    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
    });
    expect(result).not.toHaveProperty("tree");
    expect(() => renderTopikContent(result)).toThrow(InvalidTopikContentError);
    expect(() => renderTopikMarkdown(source, { config })).toThrow(InvalidTopikContentError);
    const placeholder = renderToStaticMarkup(
      renderTopikMarkdown(source, { config, invalidContent: "placeholder" }),
    );
    expect(placeholder).toContain('role="alert"');
    expect(placeholder).not.toContain("Safe child");
    expect(placeholder).not.toContain("retargeted child");
    expect(config.variables.which).toBe("safe.md");
    expect(retarget).not.toHaveBeenCalled();
  });

  it("renders a valid partial and custom function from isolated transform state", () => {
    const source = '{% partial file="safe.md" /%}';
    const functionTransform = vi.fn(() => "Safe title");
    const partial = [
      Markdoc.parse('{% partial file="nested.md" /%}'),
      Markdoc.parse("Second child"),
    ];
    const config = {
      functions: { label: { returns: String, transform: functionTransform } },
      partials: {
        "nested.md": Markdoc.parse("{% callout title=label() %}Custom child{% /callout %}"),
        "safe.md": partial,
      },
    };

    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
    expect(functionTransform).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(renderTopikContent(result));
    expect(html).toContain("Custom child");
    expect(html).toContain("Second child");
  });

  it("isolates transform partials from extension-validation graph mutations", () => {
    const source = '{% attack /%}\n{% partial file="safe.md" /%}';
    const partial = Markdoc.parse("Original child");
    const extensionValidator = vi.fn((_node, config: Config) => {
      const effectivePartial = config.partials?.["safe.md"] as { children: unknown[] };
      effectivePartial.children = [];
      return [];
    });
    const config = {
      partials: { "safe.md": partial },
      tags: { attack: { render: "div", validate: extensionValidator } },
    };

    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
    expect(extensionValidator).toHaveBeenCalledOnce();
    expect(partial.children).not.toHaveLength(0);
    expect(renderToStaticMarkup(renderTopikContent(result))).toContain("Original child");
  });

  it("refuses a sanitized extension diagnostic inside a canonically valid partial", () => {
    const source = '{% partial file="custom.md" /%}';
    const extensionValidator = vi.fn(() => [
      {
        id: "extension-invalid",
        level: "error" as const,
        message: "Rejected PRIVATE_VALUE_SENTINEL",
      },
    ]);
    const extensionTransform = vi.fn(() => new Markdoc.Tag("aside", {}, ["must not render"]));
    const config = {
      partials: {
        "custom.md": Markdoc.parse('{% notice tone="PRIVATE_VALUE_SENTINEL" /%}'),
      },
      tags: {
        notice: {
          render: "aside",
          attributes: { tone: { type: String } },
          validate: extensionValidator,
          transform: extensionTransform,
        },
      },
    };

    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [
        expect.objectContaining({
          id: "extension-invalid",
          message: "Content validation failed.",
        }),
      ],
    });
    expect(result).not.toHaveProperty("tree");
    expect(extensionValidator).toHaveBeenCalledOnce();
    expect(extensionTransform).not.toHaveBeenCalled();
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  it("refuses canonical errors before extension validation or transformation", () => {
    const source = "{% attack /%}\n{% quiz %}ordinary child{% /quiz %}";
    const extensionValidator = vi.fn((_node, config: Config) => {
      const quiz = config.tags?.quiz as Record<string, unknown>;
      Reflect.set(quiz, "validate", () => []);
      return [];
    });
    const extensionTransform = vi.fn(() => new Markdoc.Tag("div", {}, ["must not render"]));
    const config = {
      tags: {
        attack: {
          render: "div",
          validate: extensionValidator,
          transform: extensionTransform,
        },
      },
    };
    const transform = vi.spyOn(Markdoc, "transform");
    const diagnostics: unknown[] = [];

    const result = compileTopikContent(source, {
      config,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("tree");
    expect(() => renderTopikMarkdown(source, { config })).toThrow(InvalidTopikContentError);
    expect(extensionValidator).not.toHaveBeenCalled();
    expect(extensionTransform).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics)).not.toContain(source);
    transform.mockRestore();
  });

  it("validates and transforms a valid additive tag on separate AST and config graphs", () => {
    const source = '{% notice tone="quiet" %}Custom child{% /notice %}';
    let validatedNode: object | undefined;
    let validatedConfig: object | undefined;
    const extensionValidator = vi.fn((node, config) => {
      validatedNode = node;
      validatedConfig = config;
      node.tag = "renamed-during-validation";
      node.attributes.tone = "mutated-during-validation";
      node.children = [];
      Reflect.set(config.tags?.notice as Record<string, unknown>, "transform", () => "leak");
      return [];
    });
    const extensionTransform = vi.fn((node, config) => {
      expect(node).not.toBe(validatedNode);
      expect(config).not.toBe(validatedConfig);
      return new Markdoc.Tag(
        "aside",
        node.transformAttributes(config),
        node.transformChildren(config),
      );
    });
    const config = {
      tags: {
        notice: {
          render: "aside",
          attributes: { tone: { type: String } },
          validate: extensionValidator,
          transform: extensionTransform,
        },
      },
    };

    const result = compileTopikContent(source, { config });
    expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
    expect(extensionValidator).toHaveBeenCalledOnce();
    expect(extensionTransform).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(renderTopikContent(result))).toContain("Custom child");
  });

  it("refuses a sanitized extension error before transformation", () => {
    const source = '{% notice tone="PRIVATE_VALUE_SENTINEL" /%}';
    const extensionValidator = vi.fn(() => [
      {
        id: "extension-invalid",
        level: "error" as const,
        message: "Rejected PRIVATE_VALUE_SENTINEL",
      },
    ]);
    const extensionTransform = vi.fn(() => new Markdoc.Tag("aside", {}, ["must not render"]));
    const transform = vi.spyOn(Markdoc, "transform");
    const result = compileTopikContent(source, {
      config: {
        tags: {
          notice: {
            render: "aside",
            attributes: { tone: { type: String } },
            validate: extensionValidator,
            transform: extensionTransform,
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [
        expect.objectContaining({
          id: "extension-invalid",
          message: "Content validation failed.",
        }),
      ],
    });
    expect(result).not.toHaveProperty("tree");
    expect(extensionValidator).toHaveBeenCalledOnce();
    expect(extensionTransform).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
    transform.mockRestore();
  });

  it("cannot transform or render through a mutated merged canonical schema", () => {
    const source = "{% quiz %}ordinary child{% /quiz %}";
    const config = mergeTopikMarkdocConfig();
    const transform = vi.spyOn(Markdoc, "transform");
    const quiz = config.tags?.quiz as Record<string, unknown>;
    const originalValidate = quiz.validate;

    try {
      Reflect.set(quiz, "validate", () => []);
      Reflect.set(config, "tags", { quiz: { render: "TopikQuiz", validate: () => [] } });

      const result = compileTopikContent(source, { config });

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("tree");
      expect(() => renderTopikMarkdown(source, { config })).toThrow(InvalidTopikContentError);
      expect(transform).not.toHaveBeenCalled();
    } finally {
      Reflect.set(quiz, "validate", originalValidate);
      transform.mockRestore();
    }
  });

  it("cannot replace canonical validation through normal compile and Markdown rendering", () => {
    const source = "{% quiz %}{% /quiz %}";
    const config = { tags: { quiz: { render: "TopikQuiz" } } };
    const transform = vi.spyOn(Markdoc, "transform");

    const result = compileTopikContent(source, { config });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("tree");
    expect(() => renderTopikMarkdown(source, { config })).toThrow(InvalidTopikContentError);
    expect(transform).not.toHaveBeenCalled();
    transform.mockRestore();
  });

  it("compiles warning-only content and retains its diagnostic", () => {
    const source = "Warning-only content.";
    const transform = vi.spyOn(Markdoc, "transform");

    const result = compileTopikContent(source, {
      config: {
        nodes: {
          paragraph: {
            render: "p",
            validate: () => [
              { id: "test-warning", level: "warning", message: "A non-blocking warning" },
            ],
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      source,
      diagnostics: [expect.objectContaining({ id: "test-warning", level: "warning" })],
    });
    expect(result).toHaveProperty("tree");
    expect(transform).toHaveBeenCalledOnce();
    transform.mockRestore();
  });

  it.each([
    '{% mystery private="opaque" %}child{% /mystery %}',
    'Before {% mystery private="opaque" %}child{% /mystery %} after',
    '{% mystery private="outer" %}{% unknown private="inner" %}child{% /unknown %}{% /mystery %}',
    "{% quiz %}{% /quiz %}",
  ])("returns a tree-free compile failure before transformation for %s", (source) => {
    const transform = vi.spyOn(Markdoc, "transform");

    const result = compileTopikContent(source);

    expect(result).toMatchObject({ ok: false, source });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: expect.stringMatching(/^(?:error|critical)$/u) }),
      ]),
    );
    expect(result).not.toHaveProperty("tree");
    expect(transform).not.toHaveBeenCalled();
    transform.mockRestore();
  });

  it("throws by default for invalid source after reporting sanitized diagnostics", () => {
    const source = '{% mystery private="opaque" %}child{% /mystery %}';
    const diagnostics: unknown[] = [];

    expect(() =>
      renderTopikMarkdown(source, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).toThrow();
    expect(diagnostics).not.toHaveLength(0);
    expect(JSON.stringify(diagnostics)).not.toContain("opaque");
    expect(JSON.stringify(diagnostics)).not.toContain(source);
  });

  it("throws a typed error carrying the exact tree-free compile failure", () => {
    const source = '  {% mystery private="opaque" %}\r\nchild\r\n{% /mystery %}  ';
    const result = compileTopikContent(source);

    expect(result).toMatchObject({ ok: false, source });
    expect(() => renderTopikContent(result)).toThrow(InvalidTopikContentError);
    try {
      void renderTopikContent(result);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTopikContentError);
      expect((error as InvalidTopikContentError).result).toBe(result);
      expect(error).not.toHaveProperty("tree");
    }
  });

  it("keeps sensitive source and paths out of compile diagnostics and typed error messages", () => {
    const sentinel = "PRIVATE_VALUE";
    const source = `{% mystery private="${sentinel}" %}child{% /mystery %}`;
    const result = compileTopikContent(source, { file: `/tmp/${sentinel}/lesson.md` });

    expect(result).toMatchObject({ ok: false, source });
    expect(JSON.stringify(result.diagnostics)).not.toContain(sentinel);
    expect(JSON.stringify(result.diagnostics)).not.toContain("/tmp/");
    expect(() => renderTopikContent(result)).toThrow("Topik content is unsupported or invalid");
  });

  it.each(unsafeDiagnosticFiles)(
    "normalizes %s across compile results, typed errors, and callbacks",
    (file) => {
      const sentinel = "PRIVATE_VALUE_SENTINEL";
      const source = `{% callout variant="${sentinel}" %}child{% /callout %}`;
      const compileCallbacks: unknown[] = [];
      const renderCallbacks: unknown[] = [];
      const result = compileTopikContent(source, {
        file,
        onDiagnostic: (diagnostic) => compileCallbacks.push(diagnostic),
      });

      expect(result).toMatchObject({ ok: false, source });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          file: "lesson.md",
          message: "An attribute has an invalid value.",
        }),
      ]);
      expect(() => renderTopikContent(result)).toThrow(InvalidTopikContentError);
      expect(() =>
        renderTopikMarkdown(source, {
          file,
          onDiagnostic: (diagnostic) => renderCallbacks.push(diagnostic),
        }),
      ).toThrow(InvalidTopikContentError);
      for (const surface of [result.diagnostics, compileCallbacks, renderCallbacks]) {
        expect(JSON.stringify(surface)).not.toMatch(
          /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u,
        );
        expect(JSON.stringify(surface)).not.toContain(source);
      }
      try {
        void renderTopikContent(result);
      } catch (error) {
        expect((error as InvalidTopikContentError).result.source).toBe(source);
        expect((error as Error).message).not.toMatch(
          /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u,
        );
        expect(JSON.stringify((error as InvalidTopikContentError).result.diagnostics)).not.toMatch(
          /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u,
        );
      }
    },
  );

  it.each(ambiguousDiagnosticFiles)(
    "fails an ambiguous label closed across compile, callback, and typed-error surfaces",
    (file) => {
      const source = '{% callout variant="PRIVATE_VALUE_SENTINEL" /%}';
      const callbacks: unknown[] = [];
      const result = compileTopikContent(source, {
        file,
        onDiagnostic: (diagnostic) => callbacks.push(diagnostic),
      });

      expect(result).toMatchObject({ ok: false, source });
      expect(result.diagnostics).toEqual([expect.objectContaining({ file: "content" })]);
      try {
        void renderTopikContent(result);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidTopikContentError);
        const typedError = error as InvalidTopikContentError;
        expect(typedError.result.source).toBe(source);
        const surface = JSON.stringify({
          callbacks,
          diagnostics: typedError.result.diagnostics,
          message: typedError.message,
        });
        expect(surface).not.toMatch(
          /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL|%2F|%25/iu,
        );
      }
    },
  );

  it("removes unsafe evaluated card targets before custom SSR renderers", () => {
    const credential =
      "https://user:SECRET_SENTINEL@example.com/file?q=QUERY_SENTINEL#FRAGMENT_SENTINEL";
    const assetDiagnostics: string[] = [];
    const navigationDiagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          [
            '{% card title="Credential" href=$credential /%}',
            '{% card title="Scheme" href=$scheme /%}',
            '{% card title="Reserved" href=$reserved /%}',
          ].join("\n\n"),
          {
            components: {
              TopikCard: ({ href, title }) => (
                <span data-href={typeof href === "string" ? href : "missing"}>{String(title)}</span>
              ),
            },
            config: {
              variables: {
                credential,
                reserved: `asset:auto-v1-${"a".repeat(52)}`,
                scheme: "javascript:alert(1)",
              },
            },
            onAssetDiagnostic: (diagnostic) => assetDiagnostics.push(diagnostic.id),
            onNavigationDiagnostic: (diagnostic) => navigationDiagnostics.push(diagnostic.id),
          },
        )}
      </>,
    );

    expect(html.match(/data-href="missing"/gu)).toHaveLength(3);
    expect(html).not.toContain("SECRET_SENTINEL");
    expect(html).not.toContain("QUERY_SENTINEL");
    expect(html).not.toContain("FRAGMENT_SENTINEL");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("asset:");
    expect(assetDiagnostics).toEqual([]);
    expect(navigationDiagnostics).toEqual(Array(3).fill("TOPIK_NAVIGATION_REFERENCE_UNSAFE"));
  });

  const unsafeTrustedCardTargets: ReadonlyArray<readonly [string, unknown]> = [
    ["credentialed URL", "https://user:SECRET_SENTINEL@example.com/path?q=x#y"],
    ["unsafe scheme", "javascript:alert(1)"],
    ["reserved Asset locator", `asset:auto-v1-${"a".repeat(52)}`],
    ["non-string value", { toString: () => "https://example.com" }],
  ];

  it.each(unsafeTrustedCardTargets)(
    "removes a trusted card %s before its custom renderer",
    (_kind, href) => {
      const html = renderToStaticMarkup(
        <>
          {renderTrustedTopikTree(new Markdoc.Tag("TopikCard", { href, title: "Unsafe" }), {
            components: {
              TopikCard: ({ href: received }) => (
                <span data-href={typeof received === "string" ? received : "missing"} />
              ),
            },
          })}
        </>,
      );

      expect(html).toContain('data-href="missing"');
      expect(html).not.toContain("SECRET_SENTINEL");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("asset:");
    },
  );

  it("sanitizes absolute paths on manual asset diagnostics across compile failure", () => {
    const sentinel = "SENSITIVE_DIRECTORY";
    const source = "![x](é.png)";
    const result = compileTopikContent(source, { file: `/tmp/${sentinel}/lesson.md` });

    expect(result).toMatchObject({ ok: false, source });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", file: "lesson.md" }),
      ]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(sentinel);
    expect(JSON.stringify(result.diagnostics)).not.toContain("/tmp/");
  });

  it("server-renders a fixed accessible placeholder only when selected explicitly", () => {
    const source = '{% mystery private="opaque" %}leaked child{% /mystery %}';

    const html = renderToStaticMarkup(
      <>{renderTopikMarkdown(source, { invalidContent: "placeholder" })}</>,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Unsupported or invalid Topik content");
    expect(html).not.toContain("leaked child");
    expect(html).not.toContain("opaque");
    expect(html).not.toContain("mystery");
  });

  it("wraps a custom invalid-content presentation in fixed alert semantics", () => {
    const source = '{% mystery private="opaque" %}leaked child{% /mystery %}';

    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(source, {
          invalidContent: "placeholder",
          invalidContentPlaceholder: () => <strong>Cannot preview this content</strong>,
        })}
      </>,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Cannot preview this content");
    expect(html).not.toContain("leaked child");
    expect(html).not.toContain("opaque");
  });

  it("resolves names in declared slots during server rendering", () => {
    const assetNames = ["a", "b", "c", "d"].map(
      (character, index) => `auto-v1-${character.repeat(51)}${index % 2 === 0 ? "a" : "q"}`,
    );
    const names: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          [
            `![Logo](asset:${assetNames[0]})`,
            `{% figure src="asset:${assetNames[1]}" darkSrc="asset:${assetNames[2]}" alt="Figure" /%}`,
            `[Download](asset:${assetNames[3]})`,
          ].join("\n\n"),
          {
            components: {
              TopikFigure: ({ darkSrc, src }) => (
                <picture>
                  <source srcSet={String(darkSrc)} />
                  <img alt="" src={String(src)} />
                </picture>
              ),
              TopikImage: ({ src }) => <img alt="" src={String(src)} />,
              TopikLink: ({ children, href }) => <a href={String(href)}>{children}</a>,
            },
            resolveAsset: (name) => {
              names.push(name);
              return `/compiled/${name}`;
            },
          },
        )}
      </>,
    );

    expect(names).toEqual(assetNames);
    expect(html).toContain(`src="/compiled/${assetNames[0]}"`);
    expect(html).toContain(`src="/compiled/${assetNames[1]}"`);
    expect(html).toContain(`srcSet="/compiled/${assetNames[2]}"`);
    expect(html).toContain(`href="/compiled/${assetNames[3]}"`);
    expect(html).not.toContain("asset:");
  });

  it("does not recursively rewrite arbitrary strings", () => {
    const tree = new Markdoc.Tag("TopikCard", {
      title: "asset:company-logo",
      data: { nested: "asset:company-logo" },
    });
    const resolver = vi.fn(() => "/compiled/company-logo");

    const resolved = resolveTopikAssetReferences(tree, resolver);

    expect(resolver).not.toHaveBeenCalled();
    expect(resolved.attributes).toEqual(tree.attributes);
  });

  it("fails closed for an unresolved named Asset", () => {
    const name = `auto-v1-${"a".repeat(52)}`;
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(`![Logo](asset:${name})`, {
          resolveAsset: () => undefined,
          onAssetDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );

    expect(diagnostics).toContain("TOPIK_ASSET_REFERENCE_MISSING");
    expect(html).not.toContain("asset:");
    expect(html).not.toMatch(/\bsrc=/u);
  });

  it("enforces canonical full-SHA-256 base32 names at the renderer boundary", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    for (const finalSymbol of alphabet) {
      const name = `auto-v1-${"a".repeat(51)}${finalSymbol}`;
      const resolver = vi.fn(() => "/compiled/asset");
      const resolved = resolveTopikAssetReferences(
        new Markdoc.Tag("TopikImage", { src: `asset:${name}` }),
        resolver,
      );
      const expected = finalSymbol === "a" || finalSymbol === "q";
      expect(resolver.mock.calls.length > 0, name).toBe(expected);
      expect(resolved.attributes.src, name).toBe(expected ? "/compiled/asset" : undefined);
    }
    for (const name of [
      `auto-v1-${"a".repeat(51)}`,
      `auto-v1-${"a".repeat(53)}`,
      `auto-v1-${"a".repeat(51)}0`,
      `auto-v1-${"a".repeat(51)}A`,
      `auto-v1-${"a".repeat(52)}=`,
      `AUTO-v1-${"a".repeat(52)}`,
    ]) {
      const resolver = vi.fn(() => "/must-not-resolve");
      const resolved = resolveTopikAssetReferences(
        new Markdoc.Tag("TopikImage", { src: `asset:${name}` }),
        resolver,
      );
      expect(resolver, name).not.toHaveBeenCalled();
      expect(resolved.attributes, name).not.toHaveProperty("src");
    }
  });

  it("fails closed for a malformed named Asset in source and transformed trees", () => {
    const sourceDiagnostics: string[] = [];
    const resolutionDiagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown("![Logo](asset:auto-v1-short)", {
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => sourceDiagnostics.push(diagnostic.id),
        })}
      </>,
    );
    const resolved = resolveTopikAssetReferences(
      new Markdoc.Tag("TopikImage", { src: "asset:auto-v1-short" }),
      () => "/must-not-resolve",
      { onDiagnostic: (diagnostic) => resolutionDiagnostics.push(diagnostic.id) },
    );

    expect(sourceDiagnostics).toContain("TOPIK_ASSET_REFERENCE_MALFORMED");
    expect(resolutionDiagnostics).toContain("TOPIK_ASSET_REFERENCE_MALFORMED");
    expect(resolved.attributes).not.toHaveProperty("src");
    expect(html).not.toContain("asset:");
    expect(html).not.toMatch(/\bsrc=/u);
  });

  it.each([
    `ASSET:auto-v1-${"a".repeat(52)}`,
    `asset%3Aauto-v1-${"a".repeat(52)}`,
    `%61sset%3Aauto-v1-${"a".repeat(52)}`,
    `asset&#58;auto-v1-${"a".repeat(52)}`,
    "asset:auto-v1-short",
  ])("fails closed for reserved Asset alias %s in a transformed download slot", (reference) => {
    const resolver = vi.fn(() => "/must-not-resolve");
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      new Markdoc.Tag("TopikLink", { href: reference }),
      resolver,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolver).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(["TOPIK_ASSET_REFERENCE_MALFORMED"]);
    expect(resolved.attributes).not.toHaveProperty("href");
  });

  it("sanitizes reserved aliases in every rendered Asset-capable slot", () => {
    const reference = `ASSET:auto-v1-${"a".repeat(52)}`;
    const resolver = vi.fn(() => "/must-not-resolve");
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      [
        new Markdoc.Tag("TopikImage", { src: reference }),
        new Markdoc.Tag("TopikFigure", { src: reference, darkSrc: reference }),
        new Markdoc.Tag("TopikLink", { href: reference }),
      ],
      resolver,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolver).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
    expect(resolved.map((tag) => tag.attributes)).toEqual([{}, {}, {}]);
  });

  it.each([
    "http://example.com/file.png",
    "HtTp://example.com/file.png",
    "https://user:secret@example.com/file.png",
    "//example.com/file.png",
    "javascript:alert(1)",
    "data:image/png;base64,AA==",
    "file:///tmp/file.png",
    "asset:auto-v1-short",
    `ASSET:auto-v1-${"a".repeat(52)}`,
  ])("removes unsafe post-transform value %s from every Asset slot", (reference) => {
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      [
        new Markdoc.Tag("TopikImage", { src: reference }),
        new Markdoc.Tag("TopikFigure", { src: reference, darkSrc: reference }),
        new Markdoc.Tag("TopikLink", { href: reference }),
      ],
      undefined,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolved.map((tag) => tag.attributes)).toEqual([{}, {}, {}]);
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
  });

  it.each([
    ["coercible object", { toString: () => "https://user:secret@example.com/file.png" }],
    ["boxed string", Object("https://user:secret@example.com/file.png")],
    ["array", ["https://user:secret@example.com/file.png"]],
    ["number", 42],
    ["boolean", true],
    ["null", null],
  ])("omits and diagnoses a transformed %s in every Asset slot", (_kind, value) => {
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      [
        new Markdoc.Tag("TopikImage", { src: value }),
        new Markdoc.Tag("TopikFigure", { src: value, darkSrc: value }),
        new Markdoc.Tag("TopikLink", { href: value }),
      ],
      undefined,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolved.map((tag) => tag.attributes)).toEqual([{}, {}, {}]);
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
  });

  it("omits non-string values before the fallback renderer receives them", () => {
    const diagnostics: string[] = [];
    expect(() =>
      renderToStaticMarkup(
        <>
          {renderTrustedTopikTree(
            new Markdoc.Tag("article", {}, [
              new Markdoc.Tag("TopikImage", { src: { toString: () => "unsafe-image" } }),
              new Markdoc.Tag("TopikFigure", { darkSrc: Object("unsafe-dark"), src: 1 }),
              new Markdoc.Tag("TopikLink", { href: null }, ["Download"]),
            ]),
            { onAssetDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
          )}
        </>,
      ),
    ).not.toThrow();
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
  });

  it("sanitizes variable and function results before custom renderers", () => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          [
            '{% evaluatedImage src=$unsafe alt="Image" /%}',
            '{% figure src=unsafe() darkSrc=$allowed alt="Figure" /%}',
            "{% evaluatedLink href=$unsafe %}Download{% /evaluatedLink %}",
          ].join("\n\n"),
          {
            components: {
              TopikFigure: ({ darkSrc, src }) => (
                <span data-dark={String(darkSrc)} data-src={String(src)} />
              ),
              TopikImage: ({ src }) => <span data-src={String(src)} />,
              TopikLink: ({ children, href }) =>
                typeof href === "string" ? (
                  <a data-custom href={href}>
                    {children}
                  </a>
                ) : (
                  <span data-no-target>{children}</span>
                ),
            },
            config: {
              functions: { unsafe: { transform: () => "javascript:alert(1)" } },
              tags: {
                evaluatedImage: {
                  render: "TopikImage",
                  attributes: { alt: { type: String }, src: { type: String } },
                },
                evaluatedLink: {
                  render: "TopikLink",
                  attributes: { href: { type: String } },
                },
              },
              variables: {
                allowed: "HtTpS://example.com/dark.png",
                unsafe: "http://example.com/file.png",
              },
            },
            onAssetDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
          },
        )}
      </>,
    );

    expect(diagnostics).toEqual(Array(3).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
    expect(html).toContain('data-dark="HtTpS://example.com/dark.png"');
    expect(html).not.toContain("http://");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=");
    expect(html).toContain("data-no-target");
  });

  it("omits coercible non-string variable and function results before custom renderers", () => {
    const unsafe = "https://user:secret@example.com/file.png";
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          [
            '{% evaluatedImage src=$object alt="Object" /%}',
            '{% figure src=boxed() darkSrc=$array alt="Figure" /%}',
            "{% evaluatedLink href=number() %}Number{% /evaluatedLink %}",
            '{% evaluatedImage src=$boolean alt="Boolean" /%}',
            "{% evaluatedLink href=nil() %}Null{% /evaluatedLink %}",
            '{% evaluatedImage src=$allowed alt="Allowed" /%}',
          ].join("\n\n"),
          {
            components: {
              TopikFigure: ({ darkSrc, src }) => (
                <span data-dark={String(darkSrc)} data-src={String(src)} />
              ),
              TopikImage: ({ src }) => <span data-src={String(src)} />,
              TopikLink: ({ children, href }) => (
                <a data-custom href={String(href)}>
                  {children}
                </a>
              ),
            },
            config: {
              functions: {
                boxed: { transform: () => Object(unsafe) },
                nil: { transform: () => null },
                number: { transform: () => 42 },
              },
              tags: {
                evaluatedImage: {
                  render: "TopikImage",
                  attributes: { alt: { type: String }, src: { type: Object } },
                },
                evaluatedLink: {
                  render: "TopikLink",
                  attributes: { href: { type: Object } },
                },
              },
              variables: {
                allowed: "images/allowed.png",
                array: [unsafe],
                boolean: true,
                object: { toString: () => unsafe },
              },
            },
            onAssetDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
          },
        )}
      </>,
    );

    expect(diagnostics).toEqual(Array(6).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
    expect(html).toContain('data-src="images/allowed.png"');
    expect(html).not.toContain("user:secret");
    expect(html).not.toContain('href="42"');
    expect(html).not.toContain('href="null"');
    expect(html).not.toContain('data-src="true"');
  });

  it("preserves safe evaluated navigation and Asset values", () => {
    const references = [
      "guide?tab=api#install",
      "#install",
      "/guide?tab=api#install",
      "mailto:docs@example.com",
      "HtTpS://example.com/file.pdf",
    ];
    const resolved = resolveTopikAssetReferences(
      references.map((href) => new Markdoc.Tag("TopikLink", { href })),
    );
    expect(resolved.map((tag) => tag.attributes.href)).toEqual(references);
    expect(
      resolveTopikAssetReferences(
        new Markdoc.Tag("TopikFigure", {
          darkSrc: "HtTpS://example.com/dark.png",
          src: "images/light.png",
        }),
      ).attributes,
    ).toEqual({ darkSrc: "HtTpS://example.com/dark.png", src: "images/light.png" });
  });

  it.each([
    "http://example.com/file.png",
    "https://user:secret@example.com/file.png",
    "//example.com/file.png",
    "javascript:alert(1)",
    `ASSET:auto-v1-${"b".repeat(52)}`,
  ])("does not emit unsafe Asset resolver result %s", (resolvedReference) => {
    const name = `auto-v1-${"a".repeat(52)}`;
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      new Markdoc.Tag("TopikImage", { src: `asset:${name}` }),
      () => resolvedReference,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolved.attributes).not.toHaveProperty("src");
    expect(diagnostics).toEqual(["TOPIK_ASSET_REFERENCE_MISSING"]);
  });

  it.each([
    `ASSET:auto-v1-${"b".repeat(52)}`,
    `asset%3Aauto-v1-${"b".repeat(52)}`,
    `asset&#58;auto-v1-${"b".repeat(52)}`,
  ])("does not emit reserved alias %s returned by an Asset resolver", (resolvedReference) => {
    const name = `auto-v1-${"a".repeat(52)}`;
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      new Markdoc.Tag("TopikLink", { href: `asset:${name}` }),
      () => resolvedReference,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(diagnostics).toEqual(["TOPIK_ASSET_REFERENCE_MISSING"]);
    expect(resolved.attributes).not.toHaveProperty("href");
  });

  it("fails closed when a runtime Asset resolver returns a non-string value", () => {
    const name = `auto-v1-${"a".repeat(52)}`;
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      [
        new Markdoc.Tag("TopikImage", { src: `asset:${name}` }),
        new Markdoc.Tag("TopikFigure", {
          darkSrc: `asset:${name}`,
          src: `asset:${name}`,
        }),
        new Markdoc.Tag("TopikLink", { href: `asset:${name}` }),
      ],
      () => Object("https://user:secret@example.com/file.png") as string,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolved.map((tag) => tag.attributes)).toEqual([{}, {}, {}]);
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MISSING"));
  });

  it("renders basic markdown nodes", () => {
    const html = renderToStaticMarkup(<>{renderTopikMarkdown("# Hello\n\nParagraph.")}</>);

    expect(html).toContain('<h1 id="hello">Hello</h1>');
    expect(html).toContain("<p>Paragraph.</p>");
  });

  it("renders generated, duplicate, and explicit heading IDs", () => {
    const html = renderToStaticMarkup(
      <>{renderTopikMarkdown("## Setup\n\n## Setup\n\n## Introduction {% #start-here %}")}</>,
    );

    expect(html).toContain('<h2 id="setup">Setup</h2>');
    expect(html).toContain('<h2 id="setup-1">Setup</h2>');
    expect(html).toContain('<h2 id="start-here">Introduction ');
  });

  it("renders every Topik schema component with overrides", () => {
    const components = getTopikComponents({
      TopikAccordion: ({ children, title }) => (
        <section data-accordion={String(title)}>{children}</section>
      ),
      TopikBadge: ({ children }) => <mark>{children}</mark>,
      TopikCallout: ({ children, title }) => <aside data-callout={String(title)}>{children}</aside>,
      TopikCard: ({ children, title }) => <article data-card={String(title)}>{children}</article>,
      TopikCardGrid: ({ children }) => <div data-card-grid>{children}</div>,
      TopikCodeBlock: ({ content, language }) => (
        <pre data-code-block={String(language)}>{String(content)}</pre>
      ),
      TopikCodeGroup: ({ children }) => <div data-code-group>{children}</div>,
      TopikCodeTab: ({ children, title }) => (
        <section data-code-tab={String(title)}>{children}</section>
      ),
      TopikChoice: ({ children }) => <div data-choice>{children}</div>,
      TopikExplanation: ({ children }) => <div data-explanation>{children}</div>,
      TopikFigure: ({ src }) => <img alt="" src={String(src)} />,
      TopikImage: ({ src }) => <img alt="" data-image src={String(src)} />,
      TopikInlineCode: ({ children }) => <code data-inline-code>{children}</code>,
      TopikLink: ({ children, href }) => (
        <a data-link href={String(href)}>
          {children}
        </a>
      ),
      TopikMath: ({ content }) => <div data-math>{String(content)}</div>,
      TopikMathInline: ({ content }) => <span data-math-inline>{String(content)}</span>,
      TopikMermaid: ({ content }) => <div data-mermaid>{String(content)}</div>,
      TopikQuestion: ({ children }) => <div data-question>{children}</div>,
      TopikQuiz: ({ children }) => <div data-quiz>{children}</div>,
      TopikStep: ({ children, title }) => <li data-step={String(title)}>{children}</li>,
      TopikSteps: ({ children }) => <ol data-steps>{children}</ol>,
      TopikTab: ({ children, title }) => <section data-tab={String(title)}>{children}</section>,
      TopikTabs: ({ children }) => <div data-tabs>{children}</div>,
      TopikTable: ({ children }) => <table data-table>{children}</table>,
      TopikTableCell: ({ children }) => <td data-table-cell>{children}</td>,
      TopikTableHeader: ({ children }) => <th data-table-header>{children}</th>,
      TopikTableRow: ({ children }) => <tr data-table-row>{children}</tr>,
      TopikUnderline: ({ children }) => <u data-underline>{children}</u>,
    });
    const html = renderToStaticMarkup(
      <>{renderTopikMarkdown(allComponentsContent, { components })}</>,
    );

    expect(html).toContain('data-callout="Remember"');
    expect(html).toContain("data-card-grid");
    expect(html).toContain('data-card="One"');
    expect(html).toContain('data-accordion="Details"');
    expect(html).toContain("data-tabs");
    expect(html).toContain('data-tab="A"');
    expect(html).toContain("data-code-group");
    expect(html).toContain('data-code-tab="pnpm"');
    expect(html).toContain('data-code-block="sh"');
    expect(html).toContain("data-steps");
    expect(html).toContain('data-step="Install"');
    expect(html).toContain('src="assets/hero.png"');
    expect(html).toContain('src="assets/logo.png"');
    expect(html).toContain("<mark>stable</mark>");
    expect(html).toContain("data-math");
    expect(html).toContain("data-math-inline");
    expect(html).toContain("data-mermaid");
    expect(html).toContain("data-underline");
    expect(html).toContain("data-table");
    expect(html).toContain("data-table-row");
    expect(html).toContain("data-table-cell");
    expect(html).toContain("data-table-header");
    expect(html).toContain("data-quiz");
    expect(html).toContain("data-question");
    expect(html).toContain("data-choice");
    expect(html).toContain("data-explanation");
  });

  it("provides components through context while preserving portable paths", () => {
    function ContextRenderer() {
      const components = useTopikComponents();

      return (
        <>
          {renderTopikMarkdown('{% figure src="assets/logo.svg" alt="Logo" /%}', {
            components,
          })}
        </>
      );
    }

    const html = renderToStaticMarkup(
      <TopikContentProvider
        components={{
          TopikFigure: ({ src }) => <span data-src={String(src)} />,
        }}
      >
        <ContextRenderer />
      </TopikContentProvider>,
    );

    expect(html).toContain('data-src="assets/logo.svg"');
  });

  it("reports validation diagnostics", () => {
    const diagnostics: string[] = [];

    const rendered = renderTopikMarkdown("{% quiz %}{% /quiz %}", {
      invalidContent: "placeholder",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });

    expect(rendered).toBeDefined();
    expect(diagnostics).toContain("A quiz requires at least one question.");
  });

  it("does not expose untrusted link structure through renderer diagnostic callbacks", () => {
    const sentinel = "PRIVATE_VALUE";
    for (const href of [
      `https://user:${sentinel}@[`,
      `https://user:%50RIVATE_VALUE@example.invalid/path`,
      `PrivateValue:${sentinel}`,
      `https://example.invalid/?token=${sentinel}#%zz`,
    ]) {
      const diagnostics: unknown[] = [];
      void renderTopikMarkdown(`{% card title="Unsafe" href="${href}" /%}`, {
        file: `/tmp/${sentinel}/lesson.md`,
        invalidContent: "placeholder",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      expect(diagnostics, href).not.toHaveLength(0);
      const surfaces = [
        String(diagnostics),
        JSON.stringify(diagnostics),
        JSON.stringify(diagnostics.map((diagnostic) => Object.keys(diagnostic as object))),
        JSON.stringify(diagnostics.map((diagnostic) => Object.values(diagnostic as object))),
      ].join("\n");
      expect(surfaces.toLowerCase()).not.toContain("privatevalue");
      expect(surfaces).not.toContain(sentinel);
      expect(surfaces).not.toContain(href);
    }
  });

  it.each([
    "http://example.com/a.png",
    "file:///tmp/a.png",
    "data:image/png;base64,AA==",
    "blob:https://example.com/id",
    "javascript:alert(1)",
    "//example.com/a.png",
    "/absolute.png",
    "assets%2fhero.png",
    "é.png",
  ])("diagnoses and removes unsafe asset reference %s before rendering", (reference) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(`{% figure src="${reference}" alt="Unsafe" /%}`, {
          components: {
            TopikFigure: ({ darkSrc, src }) =>
              typeof src === "string" ? (
                <picture>
                  {typeof darkSrc === "string" ? <source srcSet={darkSrc} /> : null}
                  <img alt="" src={src} />
                </picture>
              ) : null,
          },
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^TOPIK_(?:ASSET_PATH_INVALID|EXTERNAL_REFERENCE_UNSAFE)$/u),
      ]),
    );
    expect(html).not.toContain(reference);
    expect(html).not.toMatch(/\b(?:src|srcset|href)="/iu);
    expect(html).not.toContain('rel="preload"');
  });

  it.each([
    "![Unsafe][id]\n\n[id]:\n  é.png\n",
    '![Unsafe][id]\n\n[id]:\n  &eacute;.png\n  "Title"\n',
  ])("does not render a parser-normalized continuation destination", (content) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("does not render a raw non-ASCII Markdown destination after parser normalization", () => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown("![Unsafe](é.png)", {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
  });

  it("does not render a raw non-ASCII reference-style image destination", () => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown("![Unsafe][id]\n\n[id]: é.png\n", {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("does not render a destination proved only by an unrelated Markdoc attribute", () => {
    const diagnostics: string[] = [];
    const source =
      '![x][id] {% callout title="![x](%C3%A9.png)" %}foo{% /callout %}\n\n> [id]: é.png';
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(source, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
  });

  it.each([
    "![Unsafe](&eacute;.png)\n",
    "![Unsafe][id]\n\n[id]: &eacute;.png\n",
    "![Unsafe](hero\\.png)\n",
  ])("does not render a parser-unescaped source destination", (content) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it.each([
    "![Nested [unsafe]](é.png)\n",
    "![Nested [unsafe]](&eacute;.png)\n",
    "![Nested [unsafe]](hero\\.png)\n",
    "![Nested [unsafe]][id]\n\n[id]: é.png\n",
    "![Nested [unsafe]][id]\n\n[id]: &eacute;.png\n",
    "![Nested [unsafe]][id]\n\n[id]: hero\\.png\n",
    "[![Nested image](é.png)](manual.bin)\n",
  ])("does not render a noncanonical destination behind a nested label", (content) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("renders canonical encoded image destinations behind nested labels", () => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          "![Inline [safe]](%C3%A9.png)\n\n![Reference [safe]][id]\n\n[id]: %C3%A9.png\n",
          {
            components: {
              TopikImage: ({ src }) => <img alt="" src={String(src)} />,
            },
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
          },
        )}
      </>,
    );
    expect(diagnostics).toEqual([]);
    expect(html.match(/src="%C3%A9\.png"/gu)).toHaveLength(2);
  });

  it.each([
    "![Inline `]`](é.png)\n",
    "![Inline `[`](&eacute;.png)\n",
    "![Inline `]`](hero\\.png)\n",
    "![Reference `]`][id]\n\n[id]: é.png\n",
    "![Reference `[`][id]\n\n[id]: &eacute;.png\n",
    "![Reference `]`][id]\n\n[id]: hero\\.png\n",
  ])("does not render a noncanonical destination behind a code-span label", (content) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("renders canonical encoded image destinations behind code-span labels", () => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          "![Inline `]`](%C3%A9.png)\n\n![Reference `[`][id]\n\n[id]: %C3%A9.png\n",
          {
            components: {
              TopikImage: ({ src }) => <img alt="" src={String(src)} />,
            },
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
          },
        )}
      </>,
    );
    expect(diagnostics).toEqual([]);
    expect(html.match(/src="%C3%A9\.png"/gu)).toHaveLength(2);
  });

  it("does not render a multiline external entity by borrowing an escaped construct", () => {
    const diagnostics: string[] = [];
    const source =
      "![Multiline](\n  https://example.com/a&amp;b\n) \\![fake](https://example.com/a&b)";
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(source, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          invalidContent: "placeholder",
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_EXTERNAL_REFERENCE_UNSAFE");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("renders canonical local and allowed external HTTPS asset references", () => {
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          '{% figure src="assets/caf%C3%A9.png" darkSrc="https://example.com/dark.png?q=1#x" alt="Hero" /%}',
          {
            components: {
              TopikFigure: ({ darkSrc, src }) => (
                <picture>
                  <source srcSet={String(darkSrc)} />
                  <img alt="" src={String(src)} />
                </picture>
              ),
            },
          },
        )}
      </>,
    );
    expect(html).toContain('src="assets/caf%C3%A9.png"');
    expect(html).toContain('srcSet="https://example.com/dark.png?q=1#x"');
  });

  it("preserves mixed-case HTTPS through custom renderers", () => {
    const content = [
      "![Image](HtTpS://example.com/image.png)",
      "[Download](hTTps://example.com/manual.pdf)",
      "<HTTPS://example.com/autolink.pdf>",
      '{% figure src="HTtPs://example.com/light.png" darkSrc="htTPs://example.com/dark.png" alt="Theme" /%}',
    ].join("\n\n");
    const customHtml = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikImage: ({ src }) => <span data-image={String(src)} />,
            TopikLink: ({ href }) => <span data-link={String(href)} />,
            TopikFigure: ({ darkSrc, src }) => (
              <span data-dark={String(darkSrc)} data-light={String(src)} />
            ),
          },
        })}
      </>,
    );

    for (const reference of [
      "HtTpS://example.com/image.png",
      "hTTps://example.com/manual.pdf",
      "HTTPS://example.com/autolink.pdf",
      "HTtPs://example.com/light.png",
      "htTPs://example.com/dark.png",
    ]) {
      expect(customHtml).toContain(reference);
    }
  });

  it("rejects mixed-case HTTP and credential-bearing HTTPS before rendering", () => {
    const diagnostics: string[] = [];
    expect(() =>
      renderTopikMarkdown(
        [
          "![HTTP](HtTp://example.com/image.png)",
          "[HTTP](hTtP://example.com/manual.pdf)",
          "<HTtp://example.com/autolink.pdf>",
          '{% figure src="hTtPs://user:secret@example.com/image.png" alt="Unsafe" /%}',
          "![Protocol relative](//example.com/image.png)",
          '{% figure src="HtTpS://[invalid" alt="Malformed" /%}',
        ].join("\n\n"),
        {
          components: {
            TopikImage: ({ src }) => <span data-image={String(src)} />,
            TopikFigure: ({ src }) => <span data-figure={String(src)} />,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        },
      ),
    ).toThrow(InvalidTopikContentError);
    expect(diagnostics).toContain("TOPIK_EXTERNAL_REFERENCE_UNSAFE");
  });

  it("preserves ordinary navigation with query and fragment", () => {
    const href = "guide?tab=assets#delivery";
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(`[Guide](${href})`, {
          components: {
            TopikLink: ({ children, href: target }) => <a href={String(target)}>{children}</a>,
          },
        })}
      </>,
    );

    expect(html).toContain(`href="${href}"`);
  });

  it("server-renders compiled content without crashing", () => {
    const result = compileTopikContent('{% callout title="SSR" %}Works.{% /callout %}');
    const html = renderToString(<>{renderTopikContent(result)}</>);

    expect(result.ok).toBe(true);
    expect(html).toContain("Works.");
  });

  it("renders portable resource-root-relative references offline without a host resolver", () => {
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          '![Offline hero](assets/getting-started/hero.png)\n\n{% figure src="assets/light.png" darkSrc="assets/dark.png" alt="Theme" /%}',
          {
            components: {
              TopikImage: ({ alt, src }) => <img alt={String(alt)} src={String(src)} />,
              TopikFigure: ({ alt, darkSrc, src }) => (
                <picture data-dark-src={String(darkSrc)}>
                  <img alt={String(alt)} src={String(src)} />
                </picture>
              ),
            },
          },
        )}
      </>,
    );

    expect(html).toContain('src="assets/getting-started/hero.png"');
    expect(html).toContain('src="assets/light.png"');
    expect(html).toContain('data-dark-src="assets/dark.png"');
  });
});
