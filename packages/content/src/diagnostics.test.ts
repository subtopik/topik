import { describe, expect, test } from "vite-plus/test";
import {
  sanitizeTopikContentDiagnostic,
  sanitizeTopikDiagnosticFile,
  topikLinkDiagnosticMessage,
  type TopikContentDiagnostic,
} from "./diagnostics";
import {
  allAmbiguousDiagnosticFiles as ambiguousDiagnosticFiles,
  unsafeDiagnosticFiles,
} from "./test-fixtures/diagnostic-files.js";
import { components, validateDocument, validateTopikContent, type Component } from "./index.js";

test.each([
  ["{% badge %}{% /badge %}", "topik-badge-children", "A badge requires inline content."],
  [
    "{% underline %}{% /underline %}",
    "topik-underline-children",
    "Underline requires inline content.",
  ],
  ["{% u %}{% /u %}", "topik-u-children", "Underline requires inline content."],
  [
    '{% mathInline content="PRIVATE_VALUE" %}Text{% /mathInline %}',
    "topik-math-inline-children",
    "Inline math cannot contain children; use its content attribute.",
  ],
  [
    "****a*b*c*",
    "topik-mark-nesting",
    "Emphasis and strong marks allow at most two levels each; strikethrough cannot be nested.",
  ],
])(
  "explains built-in source errors without exposing authored values: %s",
  (source, id, message) => {
    const result = validateTopikContent(source);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ id, message, lines: [1] }));
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE");
  },
);

test.each(Object.keys(components))(
  "explains invalid children of the built-in %s component",
  (name) => {
    const component: Component = {
      type: "topikComponent",
      name,
      props: {},
      children: [{ type: "yaml", value: "PRIVATE_VALUE" }],
    };
    const errors = validateDocument({
      type: "root",
      children:
        components[name].kind === "inline"
          ? [{ type: "paragraph", children: [component] }]
          : [component],
    });
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      const diagnostic = sanitizeTopikContentDiagnostic({
        id: error.id!,
        type: "document",
        level: "error",
        lines: [],
        message: error.message,
      });
      expect(diagnostic.message).not.toBe("Content validation failed.");
      expect(diagnostic.message).not.toContain("PRIVATE_VALUE");
    }
  },
);

test.each(["constructor", "__proto__", "toString"])(
  "diagnostic dictionaries do not accept inherited key %s",
  (id) => {
    expect(topikLinkDiagnosticMessage(id)).toBeUndefined();
    expect(
      sanitizeTopikContentDiagnostic({
        id,
        type: "text",
        level: "error",
        lines: [],
        message: "private",
      }).message,
    ).toBe("Content validation failed.");
  },
);

const privateLabelPattern =
  /SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u;

describe("diagnostic file sanitization", () => {
  test.each([
    ...ambiguousDiagnosticFiles,
    "\thttps://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
    "https&amp;#58;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  ])("fails an encoded or whitespace-ambiguous label closed: %s", (file) => {
    const label = sanitizeTopikDiagnosticFile(file);

    expect(label).toBe("content");
    expect(label).not.toMatch(privateLabelPattern);
  });

  test.each([
    ...unsafeDiagnosticFiles,
    String.raw`\Device\HarddiskVolume1\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    "file:///SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  ])("removes private suffixes from a rooted file label", (file) => {
    const label = sanitizeTopikDiagnosticFile(file);

    expect(label).toBe("lesson.md");
    expect(label).not.toMatch(privateLabelPattern);
  });

  test.each([
    String.raw`C:\SENSITIVE_DIRECTORY\?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\\server\SENSITIVE_DIRECTORY\#FRAGMENT_SENTINEL`,
    "https://user:FILE_CREDENTIAL_SENTINEL@[?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  ])("fails a malformed private file label closed: %s", (file) => {
    const label = sanitizeTopikDiagnosticFile(file);

    expect(label).toBe("content");
    expect(label).not.toMatch(privateLabelPattern);
  });

  test.each(["lesson.md", "guides/lesson.md", String.raw`guides\lesson.md`])(
    "preserves safe relative file label %s",
    (file) => {
      expect(sanitizeTopikDiagnosticFile(file)).toBe(file);
    },
  );
});

test("tag diagnostics keep their source column", () => {
  expect(validateTopikContent("Text {% badge label=x /%}\n\n{% /callout %}").errors).toEqual([
    expect.objectContaining({ id: "attribute-syntax-invalid", lines: [1], column: 6 }),
    expect.objectContaining({ id: "missing-opening", lines: [3], column: 1 }),
  ]);
  for (const column of [0, 1.5, 1_000_001, "2"])
    expect(
      sanitizeTopikContentDiagnostic({
        id: "missing-opening",
        type: "document",
        level: "critical",
        lines: [1],
        message: "",
        column: column as number,
      }),
    ).not.toHaveProperty("column");
});

test("collapse diagnostics retain only the recognized option and safe source position", () => {
  const result = validateTopikContent('~~~ts collapse="1-"\nx\n~~~');
  expect(result.valid).toBe(false);
  expect(result.errors).toContainEqual(
    expect.objectContaining({
      id: "topik-code-presentation-lines",
      option: "collapse",
      lines: [1],
      column: 1,
    }),
  );
  for (const option of ["collapseAfter", "PRIVATE_OPTION"])
    expect(
      sanitizeTopikContentDiagnostic({
        id: "topik-code-presentation-lines",
        type: "text",
        level: "error",
        lines: [],
        message: "PRIVATE_VALUE",
        option,
      }),
    ).not.toHaveProperty("option");
});

test("attribute diagnostics name the component, the attribute and what the schema accepts", () => {
  const diagnostics = (source: string) => validateTopikContent(source).errors;
  expect(diagnostics('{% callout variant="PRIVATE_VALUE" %}\nx\n{% /callout %}')).toContainEqual(
    expect.objectContaining({
      id: "attribute-value-invalid",
      message: "An attribute has an invalid value.",
      tag: "callout",
      attribute: "variant",
      expected: ["info", "tip", "warning", "danger"],
    }),
  );
  expect(diagnostics('{% callout colour="PRIVATE_VALUE" %}\nx\n{% /callout %}')).toContainEqual(
    expect.objectContaining({
      id: "attribute-undefined",
      tag: "callout",
      attribute: "colour",
      expected: ["variant", "title"],
    }),
  );
  expect(diagnostics("{% callout title=3 %}\nx\n{% /callout %}")).toContainEqual(
    expect.objectContaining({
      id: "attribute-type-invalid",
      tag: "callout",
      attribute: "title",
      expected: ["string"],
    }),
  );
  expect(diagnostics("{% unknown %}\nx\n{% /unknown %}")).toContainEqual(
    expect.objectContaining({ id: "tag-undefined", tag: "unknown" }),
  );
  for (const source of [
    '{% callout variant="PRIVATE_VALUE" %}\nx\n{% /callout %}',
    '{% callout colour="PRIVATE_VALUE" %}\nx\n{% /callout %}',
  ])
    expect(JSON.stringify(diagnostics(source))).not.toContain("PRIVATE_VALUE");
});

test("component context is kept only for bounded names on the diagnostics that define it", () => {
  const base: Omit<TopikContentDiagnostic, "id"> = {
    type: "document",
    level: "error",
    lines: [1],
    message: "PRIVATE_VALUE",
  };
  expect(
    sanitizeTopikContentDiagnostic({
      ...base,
      id: "attribute-value-invalid",
      tag: "callout",
      attribute: "variant",
      expected: ["info", "tip"],
    }),
  ).toMatchObject({ tag: "callout", attribute: "variant", expected: ["info", "tip"] });

  const unsafe = sanitizeTopikContentDiagnostic({
    ...base,
    id: "attribute-value-invalid",
    tag: "PRIVATE VALUE",
    attribute: "x".repeat(65),
    expected: ["info", "PRIVATE VALUE"],
  });
  expect(unsafe).not.toHaveProperty("tag");
  expect(unsafe).not.toHaveProperty("attribute");
  expect(unsafe).not.toHaveProperty("expected");
  expect(
    sanitizeTopikContentDiagnostic({
      ...base,
      id: "attribute-value-invalid",
      expected: Array.from({ length: 33 }, (_, index) => `v${index}`),
    }),
  ).not.toHaveProperty("expected");

  // Other diagnostics do not carry component context.
  const other = sanitizeTopikContentDiagnostic({
    ...base,
    id: "link-page-not-found",
    tag: "callout",
    attribute: "variant",
    expected: ["info"],
  });
  expect(other).not.toHaveProperty("tag");
  expect(other).not.toHaveProperty("attribute");
  expect(other).not.toHaveProperty("expected");
});
