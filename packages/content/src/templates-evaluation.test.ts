import { expect, test, vi } from "vite-plus/test";
import {
  compileTopikContent,
  CONTENT_LIMITS,
  evaluateDocument,
  parseDocument,
  writeDocument,
  sanitizeTopikContentDiagnostic,
} from "./index.js";

const code = (payload: string) =>
  `{% template code %}\n\`\`\`text\n${payload}\n\`\`\`\n{% /template code %}`;
const title = (payload: string) => `{% callout title=t"${payload}" %}\nBody.\n{% /callout %}`;

function parsed(source: string) {
  const result = parseDocument(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.document;
}

test.each(["text", 0, -0, 42, true, false, null, ""])(
  "resolves scalar %j consistently in code and attributes without changing authored data",
  (value) => {
    const source = `${title("{% $value %}")}\n\n${code("{% $value %}")}`;
    const document = parsed(source);
    const original = structuredClone(document);
    const context = { value };
    const resolved = evaluateDocument(document, context);
    const text = value === null ? "" : String(value);
    expect(resolved.children).toMatchObject([
      { type: "topikComponent", props: { title: text } },
      { type: "code", lang: "text", value: text },
    ]);
    expect(document).toEqual(original);
    expect(context).toEqual({ value });
    expect(writeDocument(document)).toContain('title=t"{% $value %}"');
    expect(writeDocument(document)).toContain("{% template code %}");
  },
);

test("evaluates nested adjacent references once and keeps all injected syntax literal", () => {
  const value = '<b>&"{% $missing %} **bold** [link](javascript:x)';
  const source = `${title("{% $data.value %}{% $data.value %}")}\n\n${code("{% $data.value %}")}`;
  const result = compileTopikContent(source, { config: { variables: { data: { value } } } });
  expect(result).toMatchObject({
    ok: true,
    source,
    tree: {
      children: [
        { name: "TopikCallout", attributes: { title: value + value } },
        { name: "TopikCodeBlock", attributes: { content: value + "\n", language: "text" } },
      ],
    },
  });
});

test("scans opener escapes once and retains backslashes and authored code whitespace", () => {
  const payload = "C:\\tools\\run\n\t{%% $missing %}\n{%%%\n{% $value %}";
  const document = parsed(code(payload));
  expect(evaluateDocument(document, { value: "{%% $missing %}" }).children).toMatchObject([
    { type: "code", value: "C:\\tools\\run\n\t{% $missing %}\n{%%\n{%% $missing %}" },
  ]);
});

test("only looks up the selected branch while validating syntax in every branch", () => {
  const source = `{% if $show %}\n${code("{% $missing %}")}\n{% else /%}\n${title("{% $value %}")}\n{% /if %}`;
  expect(
    compileTopikContent(source, { config: { variables: { show: false, value: "Visible" } } }),
  ).toMatchObject({ ok: true, tree: { children: [{ attributes: { title: "Visible" } }] } });
  expect(compileTopikContent(source, { config: { variables: { show: true } } })).toMatchObject({
    ok: false,
    diagnostics: [{ id: "topik-template-variable-missing" }],
  });
  const invalid = source.replace("$missing", "$missing[0]");
  expect(
    compileTopikContent(invalid, { config: { variables: { show: false, value: "Visible" } } }),
  ).toMatchObject({ ok: false, source: invalid, diagnostics: [{ id: "topik-template-syntax" }] });
});

test.each([
  [{}, "value", "topik-template-variable-missing"],
  [{ nested: {} }, "nested.value", "topik-template-variable-missing"],
  [{ nested: null }, "nested.value", "topik-template-variable-type"],
  [{ nested: [] }, "nested.value", "topik-template-variable-type"],
  [{ value: {} }, "value", "topik-template-variable-type"],
  [{ value: [] }, "value", "topik-template-variable-type"],
] as const)("reports a typed sanitized template failure for %j", (variables, path, id) => {
  for (const source of [title(`{% $${path} %}`), code(`{% $${path} %}`)]) {
    const callback = vi.fn();
    const result = compileTopikContent(source, {
      config: { variables },
      file: "/tmp/private-folder/guide.md",
      onDiagnostic: callback,
    });
    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [{ id, file: "guide.md", lines: [1] }],
    });
    expect(result).not.toHaveProperty("tree");
    expect(callback.mock.calls).toEqual(result.diagnostics.map((diagnostic) => [diagnostic]));
    expect(JSON.stringify(result.diagnostics)).not.toContain("private-folder");
  }
});

test.each([...Array.from({ length: 32 }, (_, index) => index), 127])(
  "refuses injected U+%i in text templates without exposing the value",
  (character) => {
    const value = "private-value" + String.fromCharCode(character);
    for (const source of [title("{% $value %}"), code("{% $value %}")]) {
      const result = compileTopikContent(source, { config: { variables: { value } } });
      expect(result).toMatchObject({
        ok: false,
        source,
        diagnostics: [{ id: "topik-template-control" }],
      });
      expect(JSON.stringify(result.diagnostics)).not.toContain("private-value");
    }
  },
);

test("never invokes context accessors or accepts inherited and executable values", () => {
  const document = parsed(code("{% $value %}"));
  const getter = vi.fn(() => "value");
  const contexts = [
    Object.defineProperty({}, "value", { enumerable: true, get: getter }),
    Object.create({ value: "inherited" }),
    { value: () => "value" },
    { value: undefined },
    { value: Symbol("value") },
    { value: 1n },
    { value: NaN },
    { value: Infinity },
    { value: new Date() },
  ];
  for (const context of contexts) expect(() => evaluateDocument(document, context)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

test.each([false, true])(
  "shares one expansion budget across prose, component attributes, and code (reversed: %s)",
  (reverse) => {
    const parts = [
      "{% $value %} ".repeat(100),
      title("{% $value %}".repeat(200)),
      code("{% $value %}".repeat(201)),
    ];
    const source = (reverse ? parts.toReversed() : parts).join("\n\n");
    expect(
      compileTopikContent(source, { config: { variables: { value: "x".repeat(2_000) } } }),
    ).toMatchObject({ ok: false, source, diagnostics: [{ id: "topik-content-limit" }] });
  },
);

test("checks the entire derived document budget, including static template text", () => {
  const source = code("s".repeat(10_000) + "{% $value %}".repeat(500));
  expect(
    compileTopikContent(source, { config: { variables: { value: "x".repeat(1_990) } } }),
  ).toMatchObject({ ok: false, source, diagnostics: [{ id: "topik-content-limit" }] });
  expect(CONTENT_LIMITS.dataStringLength).toBe(1_000_000);
});

test("reserves the complete derived data budget before allocating expanded templates", () => {
  const document = parsed(
    [title("s".repeat(300_000) + "{% $value %}"), title("s".repeat(300_000) + "{% $value %}")].join(
      "\n\n",
    ),
  );
  const originalJoin = Array.prototype.join;
  let expanded = 0;
  const join = vi.spyOn(Array.prototype, "join").mockImplementation(function (
    this: unknown[],
    separator,
  ) {
    const result = originalJoin.call(this, separator);
    if (separator === "" && result.length >= 600_000) expanded += result.length;
    return result;
  });
  try {
    expect(() => evaluateDocument(document, { value: "x".repeat(300_000) })).toThrow(/limit/);
    expect(expanded).toBe(0);
  } finally {
    join.mockRestore();
  }
});

test("ordinary code and quoted attributes remain context-free literals", () => {
  const source =
    '{% callout title="{% $missing %}" %}\nBody.\n{% /callout %}\n\n```text\n{% $missing %}\n```';
  expect(compileTopikContent(source)).toMatchObject({
    ok: true,
    tree: {
      children: [
        { attributes: { title: "{% $missing %}" } },
        { name: "TopikCodeBlock", attributes: { content: "{% $missing %}\n" } },
      ],
    },
  });
});

test("identifies the authored attribute and path without including supplied values", () => {
  const source =
    '{% figure src="image.png" alt=t"{% $image.alt %}" caption=t"{% $image.caption %}" /%}';
  const result = compileTopikContent(source, {
    config: { variables: { image: { alt: "Visible" } } },
  });
  expect(result).toMatchObject({
    ok: false,
    source,
    diagnostics: [
      { id: "topik-template-variable-missing", attribute: "caption", variable: "image.caption" },
    ],
  });
});

test("bounds diagnostic variable paths and rejects untrusted template context labels", () => {
  const path = "a".repeat(257);
  const source = title(`{% $${path} %}`);
  const result = compileTopikContent(source);
  expect(result).toMatchObject({ ok: false, diagnostics: [{ attribute: "title" }] });
  expect(result.diagnostics[0]).not.toHaveProperty("variable");
  expect(
    sanitizeTopikContentDiagnostic({
      id: "topik-template-variable-missing",
      type: "topikComponent",
      level: "error",
      lines: [1],
      message: "untrusted",
      attribute: "untrusted",
      variable: "untrusted\nvalue",
    }),
  ).toEqual({
    id: "topik-template-variable-missing",
    type: "topikComponent",
    level: "error",
    lines: [1],
    message: "A template variable is not defined.",
  });
});

test("propagates application diagnostic callback failures for expected template errors", () => {
  const error = new Error("Callback failed");
  expect(() =>
    compileTopikContent(title("{% $missing %}"), {
      onDiagnostic: () => {
        throw error;
      },
    }),
  ).toThrow(error);
});
