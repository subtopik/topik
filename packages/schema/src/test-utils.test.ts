import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { listYamlFiles, parseFixture } from "./test-utils";

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
