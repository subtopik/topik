import { describe, expect, test } from "vite-plus/test";
import { validateTopikContent } from "./validate.js";

function ids(source: string): string[] {
  return validateTopikContent(source).errors.map((error) => error.id);
}

describe("catalog validation", () => {
  test("accepts a representative page with cards, code, media, and a quiz", () => {
    const source =
      "# Prepare\n\n" +
      '{% callout variant="tip" %}\n\nRead the guide.\n\n{% /callout %}\n\n' +
      '{% cardGrid columns=2 %}\n\n{% card title="Guide" href="/guide" /%}\n\n{% /cardGrid %}\n\n' +
      '{% codeGroup %}\n\n{% codeTab title="TypeScript" %}\n\n```ts\nconst ready = true;\n```\n\n{% /codeTab %}\n\n{% /codeGroup %}\n\n' +
      '{% figure src="images/hero.png" darkSrc="images/hero-dark.png" alt="Hero" /%}\n\n' +
      "{% quiz %}\n\n{% question %}\n\n{% choice correct=true %}\n\nA.\n\n{% /choice %}\n\n" +
      "{% choice %}\n\nB.\n\n{% /choice %}\n\n{% /question %}\n\n{% /quiz %}";
    expect(validateTopikContent(source)).toMatchObject({ source, valid: true, errors: [] });
  });

  test.each([
    ['{% figure src="x" /%}', "attribute-missing-required"],
    [
      '{% accordion title="Details" open="true" %}\n\nText.\n\n{% /accordion %}',
      "attribute-type-invalid",
    ],
    ['{% badge variant="unknown" %}X{% /badge %}', "attribute-value-invalid"],
    ['{% callout unknown="x" %}\n\nText.\n\n{% /callout %}', "attribute-undefined"],
    ["{% cardGrid columns=5 %}\n\n{% /cardGrid %}", "topik-columns-range"],
  ])("reports stable attribute IDs and retains source", (source, id) => {
    const result = validateTopikContent(source);
    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors.map((error) => error.id)).toContain(id);
  });

  test("retains structural and semantic diagnostics across the source boundary", () => {
    // Detailed component rule matrices live in extensions/*.test.ts. This checks
    // their public diagnostic projection together, including ordering and locations.
    const source = [
      "Intro.",
      "",
      "{% tabs %}",
      "Text.",
      "{% /tabs %}",
      "",
      "{% choice %}",
      "Loose.",
      "{% /choice %}",
      "",
      "{% quiz %}",
      "{% question %}",
      "{% choice correct=true %}",
      "Yes.",
      "{% /choice %}",
      "{% /question %}",
      "{% /quiz %}",
    ].join("\n");
    const result = validateTopikContent(source, { file: "/private/workspace/lesson.md" });
    expect(result).toMatchObject({
      source,
      valid: false,
      errors: [
        {
          id: "topik-tabs-children",
          message: "Tabs contain an unsupported child.",
          lines: [3],
          file: "lesson.md",
        },
        {
          id: "topik-question-parent-required",
          message: "Choices and explanations must be nested inside a question.",
          lines: [7],
          file: "lesson.md",
        },
        {
          id: "topik-question-choice-count",
          message: "A question requires at least two choices.",
          lines: [12],
          file: "lesson.md",
        },
      ],
    });
  });
});

describe("validation boundary", () => {
  test("unknown tags and unsupported grammar are refused with retained source", () => {
    for (const source of ["{% unknown /%}", "{% $name + 1 %}", "{% else /%}"])
      expect(validateTopikContent(source)).toMatchObject({ source, valid: false });
    expect(ids("{% unknown /%}")).toContain("tag-undefined");
  });

  test("diagnostics expose line and sanitized file without authored secrets", () => {
    const result = validateTopikContent("{% card title=3 /%}", {
      file: "/private/workspace/lesson.md",
    });
    expect(result).toMatchObject({ source: "{% card title=3 /%}", valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "attribute-type-invalid", file: "lesson.md", lines: [1] }),
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toContain("/private/workspace");
  });
});
