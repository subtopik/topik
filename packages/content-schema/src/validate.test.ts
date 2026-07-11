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
    expect(topikComponents.callout.attributes?.variant.values).toContain("warning");
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

{% figure src="./hero.png" darkSrc="./hero-dark.png" alt="Course dashboard" caption="Dashboard overview" /%}

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
    expect(idsFor('{% card href="/docs" /%}')).toContain("attribute-missing-required");
    expect(idsFor('{% figure src="./image.png" /%}')).toContain("attribute-missing-required");
    expect(
      idsFor('{% figure src="./image.png" darkSrc="./image-dark.png" alt="Image" /%}'),
    ).toEqual([]);
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

![Hero](asset:hero)

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
