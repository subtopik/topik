import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Ajv2020 from "ajv/dist/2020";

const fixturesPath = join(import.meta.dirname, "..", "fixtures");

function parseFixture(path: string): unknown[] {
  const content = readFileSync(path, "utf-8");
  // Split multi-document YAML
  const documents = content.split(/^---$/m).filter((doc) => doc.trim().length > 0);
  return documents.map((doc) => parseYaml(doc));
}

function listYamlFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return [];
  }
}

export function testSchema(resourceName: string, validate: ReturnType<Ajv2020["compile"]>) {
  describe(`${resourceName} schema`, () => {
    describe("valid fixtures", () => {
      const validPath = join(fixturesPath, resourceName, "valid");
      for (const file of listYamlFiles(validPath)) {
        test(file, () => {
          const documents = parseFixture(join(validPath, file));
          for (const data of documents) {
            const result = validate(data);
            if (!result) {
              console.error(validate.errors);
            }
            expect(result).toBe(true);
          }
        });
      }
    });

    describe("invalid fixtures", () => {
      const invalidPath = join(fixturesPath, resourceName, "invalid");
      for (const file of listYamlFiles(invalidPath)) {
        test(file, () => {
          const documents = parseFixture(join(invalidPath, file));
          for (const data of documents) {
            const result = validate(data);
            expect(result).toBe(false);
          }
        });
      }
    });
  });
}
