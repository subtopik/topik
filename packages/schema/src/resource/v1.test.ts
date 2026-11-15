import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrorObject } from "ajv/dist/2020";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import {
  assertExpectedFailure,
  createValidator,
  listYamlFiles,
  parseExpectations,
  parseFixture,
} from "../test-utils";
import assetV1Schema from "../asset/v1.json" with { type: "json" };
import courseV1Schema from "../course/v1.json" with { type: "json" };
import courseModuleV1Schema from "../course-module/v1.json" with { type: "json" };
import coursePageV1Schema from "../course-page/v1.json" with { type: "json" };
import guideV1Schema from "../guide/v1.json" with { type: "json" };
import personV1Schema from "../person/v1.json" with { type: "json" };
import wikiV1Schema from "../wiki/v1.json" with { type: "json" };
import wikiPageV1Schema from "../wiki-page/v1.json" with { type: "json" };
import resourceV1Schema from "./v1.json" with { type: "json" };
import type { Resource } from "./v1";

const fixturesPath = join(import.meta.dirname, "..", "..", "fixtures");
const resourceSchemas = {
  asset: assetV1Schema,
  course: courseV1Schema,
  "course-module": courseModuleV1Schema,
  "course-page": coursePageV1Schema,
  guide: guideV1Schema,
  person: personV1Schema,
  wiki: wikiV1Schema,
  "wiki-page": wikiPageV1Schema,
};
const fixtureResources = readdirSync(fixturesPath, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "resource")
  .map((entry) => entry.name as keyof typeof resourceSchemas);

function createResourceValidator(allErrors = false) {
  const ajv = createValidator({ formats: true, allErrors });
  ajv.addSchema(Object.values(resourceSchemas));
  return ajv;
}

const validateResource = createResourceValidator().compile(resourceV1Schema);
const diagnose = createResourceValidator(true);
diagnose.addSchema(resourceV1Schema);

function errorsFor(schemaRef: string, data: unknown): ErrorObject[] {
  const validate = diagnose.getSchema(schemaRef);
  if (!validate) throw new Error(`Unknown schema reference ${schemaRef}`);
  return validate(data) ? [] : (validate.errors ?? []);
}

/** Reported errors without the schema location, which differs inside the union. */
function describeErrors(errors: readonly ErrorObject[]) {
  return errors.map(({ instancePath, keyword, params }) => ({ instancePath, keyword, params }));
}

describe("Resource/v1 schema", () => {
  test("has the canonical versioned schema identifier", () => {
    expect(resourceV1Schema.$id).toBe("https://topik.dev/schemas/resource/v1.json");
  });

  test("covers every resource schema once, discriminated by type", () => {
    expect(fixtureResources.toSorted()).toEqual(Object.keys(resourceSchemas).toSorted());
    expect(resourceV1Schema.allOf.map((branch) => branch.then.$ref)).toEqual(
      Object.keys(resourceSchemas).map((resource) => `../${resource}/v1.json`),
    );
    expect(resourceV1Schema.properties.type.enum).toEqual(
      Object.values(resourceSchemas).map((schema) => schema.properties.type.const),
    );
    expect(resourceV1Schema.allOf.map((branch) => branch.if.properties.type.const)).toEqual(
      resourceV1Schema.properties.type.enum,
    );
  });

  test("types the union of every resource envelope", () => {
    expectTypeOf<Resource["type"]>().toEqualTypeOf<
      "Asset" | "Course" | "CourseModule" | "CoursePage" | "Guide" | "Person" | "Wiki" | "WikiPage"
    >();
    expectTypeOf<Extract<Resource, { type: "Guide" }>["spec"]["content"]["format"]>().toEqualTypeOf<
      "topik" | "other"
    >();
  });

  for (const resource of fixtureResources) {
    describe(`${resource} fixtures`, () => {
      const schemaId = resourceSchemas[resource].$id;
      const validPath = join(fixturesPath, resource, "valid");
      for (const file of listYamlFiles(validPath)) {
        test(`accepts valid/${file}`, () => {
          for (const data of parseFixture(join(validPath, file))) {
            expect(validateResource(data), JSON.stringify(validateResource.errors)).toBe(true);
          }
        });
      }

      const invalidPath = join(fixturesPath, resource, "invalid");
      for (const file of listYamlFiles(invalidPath)) {
        test(`rejects invalid/${file} with the resource schema's errors`, () => {
          for (const data of parseFixture(join(invalidPath, file))) {
            expect(validateResource(data)).toBe(false);
            const unionErrors = errorsFor(resourceV1Schema.$id, data).filter(
              // The selected `then` branch reports its errors and then an `if` failure.
              ({ instancePath, keyword }) => !(instancePath === "" && keyword === "if"),
            );
            // A fixture with another resource's `type` is checked as that resource.
            const selected =
              Object.values(resourceSchemas).find(
                (schema) => schema.properties.type.const === (data as { type?: unknown }).type,
              )?.$id ?? schemaId;
            expect(describeErrors(unionErrors)).toEqual(describeErrors(errorsFor(selected, data)));
          }
        });
      }
    });
  }

  describe("invalid union fixtures", () => {
    const invalidPath = join(fixturesPath, "resource", "invalid");
    for (const file of listYamlFiles(invalidPath)) {
      test(file, () => {
        const path = join(invalidPath, file);
        const expectations = parseExpectations(readFileSync(path, "utf-8"));
        expect(expectations.length).toBeGreaterThan(0);
        for (const data of parseFixture(path)) {
          expect(validateResource(data)).toBe(false);
          assertExpectedFailure(errorsFor, resourceV1Schema.$id, data, expectations);
        }
      });
    }
  });

  test("names the supported types when the type is unknown", () => {
    const [data] = parseFixture(join(fixturesPath, "resource", "invalid", "unknown-type.yaml"));
    expect(errorsFor(resourceV1Schema.$id, data)).toEqual([
      expect.objectContaining({
        instancePath: "/type",
        keyword: "enum",
        message: "must be equal to one of the allowed values",
        params: { allowedValues: resourceV1Schema.properties.type.enum },
      }),
    ]);
    expect(validateResource(data)).toBe(false);
    expect(validateResource.errors).toEqual([
      expect.objectContaining({ instancePath: "/type", keyword: "enum" }),
    ]);
  });
});
