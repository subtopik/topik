import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  assertExpectedFailure,
  createValidator,
  listYamlFiles,
  parseExpectations,
  parseFixture,
} from "./test-utils";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "topik-schema-fixtures-"));
  roots.push(root);
  return root;
}

test("fixture discovery preserves filesystem failures", () => {
  const root = fixtureRoot();
  expect(() => listYamlFiles(join(root, "missing"))).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
  const file = join(root, "file");
  writeFileSync(file, "not a directory");
  expect(() => listYamlFiles(file)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
});

test.each(["valid", "invalid"])("requires YAML fixtures in the %s directory", (category) => {
  const dir = join(fixtureRoot(), category);
  mkdirSync(dir);
  expect(() => listYamlFiles(dir)).toThrow(
    `Schema fixture directory contains no YAML files: ${dir}`,
  );
  writeFileSync(join(dir, "README.md"), "Fixture documentation");
  expect(() => listYamlFiles(dir)).toThrow(
    `Schema fixture directory contains no YAML files: ${dir}`,
  );
  writeFileSync(join(dir, "basic.yaml"), "name: example\n");
  expect(listYamlFiles(dir)).toEqual(["basic.yaml"]);
});

test("fixture reads preserve missing-file failures", () => {
  expect(() => parseFixture(join(fixtureRoot(), "missing.yaml"))).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
});

test.each(["", " \n\t\n", "---\n", "---\n\n---\n"])(
  "rejects a fixture with no documents: %j",
  (content) => {
    const path = join(fixtureRoot(), "empty.yaml");
    writeFileSync(path, content);
    expect(() => parseFixture(path)).toThrow(`Schema fixture contains no documents: ${path}`);
  },
);

test("preserves multiple documents and ignores empty separator segments", () => {
  const path = join(fixtureRoot(), "multiple.yaml");
  writeFileSync(path, "---\nname: first\n---\n\n---\nname: second\n---\n");
  expect(parseFixture(path)).toEqual([{ name: "first" }, { name: "second" }]);
});

test("retains explicit null documents for schema validation", () => {
  const path = join(fixtureRoot(), "null.yaml");
  writeFileSync(path, "null\n");
  expect(parseFixture(path)).toEqual([null]);
});

test("parses fixture expectations", () => {
  expect(
    parseExpectations(
      [
        "# expect: (root) required spec",
        "# expect: /spec/navigation/0 oneOf via pageNode",
        "# expect: /spec/title minLength",
        "apiVersion: v1",
      ].join("\n"),
    ),
  ).toEqual([
    { instancePath: "", keyword: "required", property: "spec" },
    { instancePath: "/spec/navigation/0", keyword: "oneOf", via: "pageNode" },
    { instancePath: "/spec/title", keyword: "minLength" },
  ]);
  for (const line of [
    "# expect: spec required",
    "# expect: /spec",
    "# expect: /spec required a b",
    "# expect: /spec required via node",
    "# expect: /spec oneOf via",
  ])
    expect(() => parseExpectations(line), line).toThrow("Malformed fixture expectation");
});

describe("expected fixture failures", () => {
  const schema = {
    $id: "https://topik.dev/schemas/test/v1.json",
    type: "object",
    properties: {
      spec: {
        type: "object",
        properties: {
          title: { type: "string" },
          nodes: { type: "array", items: { $ref: "#/$defs/node" } },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    $defs: {
      node: { oneOf: [{ $ref: "#/$defs/page" }, { $ref: "#/$defs/link" }] },
      page: {
        type: "object",
        properties: { type: { const: "page" }, page: { type: "string" }, slug: { type: "string" } },
        required: ["type", "page", "slug"],
        additionalProperties: false,
      },
      link: {
        type: "object",
        properties: { type: { const: "link" }, href: { type: "string" } },
        required: ["type", "href"],
        additionalProperties: false,
      },
    },
  };
  const ajv = createValidator({ allErrors: true });
  ajv.addSchema(schema);
  const validate = (ref: string, data: unknown) => {
    const validator = ajv.getSchema(ref)!;
    return validator(data) ? [] : validator.errors!;
  };
  const check = (data: unknown, lines: string[]) =>
    assertExpectedFailure(
      validate,
      schema.$id,
      data,
      parseExpectations(lines.map((line) => `# expect: ${line}`).join("\n")),
    );

  test("accepts a failure with exactly the declared cause", () => {
    check({ spec: {} }, ["/spec required title"]);
  });

  test("rejects an additional, undeclared cause", () => {
    expect(() => check({ spec: { slug: "stale" } }, ["/spec required title"])).toThrow(
      "attributable",
    );
  });

  test("rejects a declared cause that is not reported", () => {
    expect(() => check({ spec: { title: 1 } }, ["/spec required title"])).toThrow();
  });

  test("attributes union branch mismatches and checks the intended variant", () => {
    const node = (value: object) => ({ spec: { title: "t", nodes: [value] } });
    check(node({ type: "page", slug: "s" }), [
      "/spec/nodes/0 oneOf via page",
      "/spec/nodes/0 required page",
    ]);
    check(node({ type: "unknown" }), ["/spec/nodes/0 oneOf"]);
    expect(() =>
      check(node({ type: "page" }), [
        "/spec/nodes/0 oneOf via page",
        "/spec/nodes/0 required page",
      ]),
    ).toThrow("attributable");
    expect(() =>
      check({ spec: { nodes: [{ type: "unknown" }] } }, ["/spec/nodes/0 oneOf"]),
    ).toThrow("attributable");
  });
});
