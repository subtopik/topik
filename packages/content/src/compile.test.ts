import { expect, test, vi } from "vite-plus/test";
import { compileTopikContent, type TopikContentConfig } from "./index.js";

test("compiles scoped references, variables, and authored heading IDs into a standalone reader tree", () => {
  const source = [
    "{% if $teacher %}",
    "## Setup",
    "{% else /%}",
    "Hello {% $name %}. [Read][guide]",
    "",
    "[guide]: /student",
    "{% /if %}",
    "",
    "## Setup",
  ].join("\n");
  const config = { variables: { teacher: false, name: "**Ada**" } };
  const original = structuredClone(config);
  expect(JSON.parse(JSON.stringify(compileTopikContent(source, { config })))).toEqual({
    ok: true,
    source,
    diagnostics: [],
    tree: {
      type: "element",
      name: "article",
      attributes: {},
      children: [
        {
          type: "element",
          name: "p",
          attributes: {},
          children: [
            "Hello **Ada**. ",
            {
              type: "element",
              name: "TopikLink",
              attributes: { href: "/student" },
              children: ["Read"],
            },
          ],
        },
        null,
        { type: "element", name: "h2", attributes: { id: "setup-1" }, children: ["Setup"] },
      ],
    },
  });
  expect(config).toEqual(original);
});

test.each([
  ["{% unknown /%}", {}, "tag-undefined"],
  ["{% $missing %}", {}, "topik-transform-failed"],
  ["Hello", { partials: {} }, "topik-config-invalid"],
] as const)(
  "compilation reports a sanitized failure without a tree for %s",
  (source, config, id) => {
    const onDiagnostic = vi.fn();
    const result = compileTopikContent(source, {
      config: config as TopikContentConfig,
      file: "/tmp/PRIVATE_DIRECTORY/lesson.md",
      onDiagnostic,
    });
    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [expect.objectContaining({ id, file: "lesson.md" })],
    });
    expect(result).not.toHaveProperty("tree");
    expect(onDiagnostic.mock.calls).toEqual(result.diagnostics.map((diagnostic) => [diagnostic]));
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE_DIRECTORY");
  },
);

test("compilation accepts canonical compiled assets and checks inactive branch destinations", () => {
  const reference = `asset:auto-v1-${"a".repeat(52)}`;
  expect(compileTopikContent(`![Logo](${reference})`)).toMatchObject({
    ok: true,
    tree: { children: [{ children: [{ name: "TopikImage", attributes: { src: reference } }] }] },
  });
  const source = "{% if false %}\n![Hidden](javascript:alert)\n{% /if %}";
  expect(compileTopikContent(source)).toMatchObject({ ok: false, source });
});

test("diagnostic callback errors propagate to the caller", () => {
  const error = new Error("Application callback failed");
  for (const source of ["{% unknown /%}", "{% $missing %}"]) {
    expect(() =>
      compileTopikContent(source, {
        onDiagnostic: () => {
          throw error;
        },
      }),
    ).toThrow(error);
  }
});
