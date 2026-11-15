import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, test } from "vite-plus/test";
import { listYamlFiles, parseFixture } from "./test-utils";

const packageDirectory = join(import.meta.dirname, "..");
const readme = readFileSync(join(packageDirectory, "README.md"), "utf-8");
const schemaFiles = readdirSync(join(packageDirectory, "src"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    readdirSync(join(packageDirectory, "src", entry.name))
      .filter((file) => /^v[1-9][0-9]*\.json$/u.test(file))
      .map((file) => ({
        resource: entry.name,
        path: join(packageDirectory, "src", entry.name, file),
      })),
  );

/** Resource schemas; the `resource` union only references them. */
const resourceSchemas = schemaFiles.filter(({ resource }) => resource !== "resource");

function camelCase(resource: string) {
  return resource.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

/** The validator setup the README shows: Ajv defaults plus `ajv-formats`. */
function readmeValidator() {
  const ajv = new Ajv2020();
  addFormats(ajv);
  return ajv;
}

describe("README validation example", () => {
  test("shows the setup exercised below", () => {
    expect(readme).toContain('import addFormats from "ajv-formats";');
    expect(readme).toMatch(/const ajv = new Ajv2020\(\);\naddFormats\(ajv\);\n/u);
  });

  test("covers every published schema", () => {
    expect(schemaFiles.map(({ resource }) => resource).sort()).toEqual([
      "asset",
      "course",
      "course-module",
      "course-page",
      "guide",
      "person",
      "resource",
      "wiki",
      "wiki-page",
    ]);
  });

  test("loads the Resource union with the resource schemas it references", () => {
    const members = resourceSchemas.map(({ resource }) => resource);
    expect(readme).toContain(
      `ajv.addSchema([\n${members.map((resource) => `  ${camelCase(resource)}Schema,\n`).join("")}]);\n`,
    );
    for (const resource of [...members, "resource"]) {
      expect(readme).toContain(
        `import ${camelCase(resource)}Schema from "@topik/schema/${resource}/v1.json" with { type: "json" };`,
      );
    }

    const ajv = readmeValidator();
    ajv.addSchema(resourceSchemas.map(({ path }) => JSON.parse(readFileSync(path, "utf-8"))));
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(packageDirectory, "src", "resource", "v1.json"), "utf-8")),
    );
    for (const resource of members) {
      const validPath = join(packageDirectory, "fixtures", resource, "valid");
      for (const file of listYamlFiles(validPath)) {
        for (const data of parseFixture(join(validPath, file))) {
          expect(validate(data), `${resource}/${file}`).toBe(true);
        }
      }
    }
    expect(validate({ apiVersion: "v1", type: "Tutorial", name: "x", spec: {} })).toBe(false);
  });

  for (const { resource, path } of resourceSchemas) {
    test(`compiles ${resource} and accepts its valid fixtures`, () => {
      const validate = readmeValidator().compile(JSON.parse(readFileSync(path, "utf-8")));
      const validPath = join(packageDirectory, "fixtures", resource, "valid");
      for (const file of listYamlFiles(validPath)) {
        for (const data of parseFixture(join(validPath, file))) {
          expect(validate(data), `${resource}/${file}`).toBe(true);
        }
      }
    });
  }
});
