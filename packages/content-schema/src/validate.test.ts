import Markdoc from "@markdoc/markdoc";
import { describe, expect, test } from "vite-plus/test";
import { topikComponents } from "./components";
import { topikMarkdocConfig } from "./config";
import { validateTopikContent } from "./validate";

function idsFor(source: string): string[] {
  return validateTopikContent(source).errors.map((error) => error.id);
}

describe("topik content schema", () => {
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

  test.each(['"title (detail)"', "'title (detail)'", "(title detail)"])(
    "accepts image and possible-download references with Markdoc inline title form %s",
    (title) => {
      expect(
        validateTopikContent(`![Hero](hero.png ${title})\n\n[Manual](manual.bin ${title})\n`),
      ).toMatchObject({ valid: true, errors: [] });
    },
  );

  test.each([
    "[HTTP file](http://example.com/file.pdf)",
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
