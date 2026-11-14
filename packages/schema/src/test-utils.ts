import { describe, test, expect } from "vite-plus/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { isScalar, parseAllDocuments } from "yaml";

const fixturesPath = join(import.meta.dirname, "..", "fixtures");

export function parseFixture(path: string): unknown[] {
  const documents = parseAllDocuments(readFileSync(path, "utf-8")).filter(
    // Separators without content yield an empty plain scalar; explicit `null` is retained.
    ({ contents }) => contents !== null && !(isScalar(contents) && contents.source === ""),
  );
  if (documents.length === 0) throw new Error(`Schema fixture contains no documents: ${path}`);
  return documents.map((document) => {
    if (document.errors.length > 0) throw document.errors[0];
    return document.toJS();
  });
}

export function listYamlFiles(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  if (files.length === 0)
    throw new Error(`Schema fixture directory contains no YAML files: ${dir}`);
  return files;
}

export interface ValidatorOptions {
  formats?: boolean;
  discriminator?: boolean;
  allErrors?: boolean;
}

export function createValidator({
  formats = false,
  discriminator = false,
  allErrors = false,
}: ValidatorOptions = {}) {
  const validator = new Ajv2020({ strict: true, discriminator, allErrors });
  if (formats) addFormats(validator);
  return validator;
}

/**
 * One `# expect: <instancePath> <keyword> [property] [via <$defs name>]` line in
 * an invalid fixture. `(root)` names the document root. `property` is the
 * missing or additional property name reported by `required` and
 * `additionalProperties`. A `oneOf`/`anyOf` expectation states that a node matches
 * no variant; `via` names the intended variant, which must then fail only for the
 * expectations nested at or below that node.
 */
export interface FixtureExpectation {
  instancePath: string;
  keyword: string;
  property?: string;
  via?: string;
}

const expectationLine = /^# expect: (.*)$/gm;
const unionKeywords = new Set(["anyOf", "oneOf"]);

export function parseExpectations(content: string): FixtureExpectation[] {
  return [...content.matchAll(expectationLine)].map(([line, body]) => {
    const tokens = body.trim().split(/\s+/);
    const viaIndex = tokens.indexOf("via");
    const via = viaIndex === -1 ? undefined : tokens[viaIndex + 1];
    const [path, keyword, property, ...rest] = viaIndex === -1 ? tokens : tokens.slice(0, viaIndex);
    if (
      path === undefined ||
      keyword === undefined ||
      rest.length > 0 ||
      (viaIndex !== -1 && (via === undefined || tokens.length !== viaIndex + 2)) ||
      (path !== "(root)" && !path.startsWith("/")) ||
      (via !== undefined && !unionKeywords.has(keyword))
    )
      throw new Error(`Malformed fixture expectation: ${line}`);
    return {
      instancePath: path === "(root)" ? "" : path,
      keyword,
      ...(property === undefined ? {} : { property }),
      ...(via === undefined ? {} : { via }),
    };
  });
}

function reportedProperty(error: ErrorObject): string | undefined {
  const params = error.params as { missingProperty?: string; additionalProperty?: string };
  return params.missingProperty ?? params.additionalProperty;
}

function matches(error: ErrorObject, expectation: FixtureExpectation): boolean {
  return (
    error.instancePath === expectation.instancePath &&
    error.keyword === expectation.keyword &&
    reportedProperty(error) === expectation.property
  );
}

/** True when `path` is `ancestor` itself or lies below it. */
function within(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function describeError(error: ErrorObject): string {
  const property = reportedProperty(error);
  return [error.instancePath || "(root)", error.keyword, ...(property ? [property] : [])].join(" ");
}

function resolvePointer(data: unknown, pointer: string): unknown {
  let value = data;
  for (const segment of pointer.split("/").slice(1)) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error(`Fixture expectation path does not exist: ${pointer}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Validate `data` with all errors and require that every reported error is
 * attributable to a declared expectation, and every expectation is reported.
 * Errors inside a node whose union failure is expected are union-branch
 * mismatches; when the intended variant is named, it is validated on its own.
 */
export function assertExpectedFailure(
  validate: (schemaRef: string, data: unknown) => ErrorObject[],
  rootRef: string,
  data: unknown,
  expectations: readonly FixtureExpectation[],
  basePath = "",
): void {
  const unions = expectations.filter(({ keyword }) => unionKeywords.has(keyword));
  const variants = unions.filter(({ via }) => via !== undefined);
  const inVariant = (expectation: FixtureExpectation, variant: FixtureExpectation) =>
    variant !== expectation && within(expectation.instancePath, variant.instancePath);
  // Expectations at or below a named variant are checked by validating that variant.
  const direct = expectations.filter(
    (expectation) => !variants.some((variant) => inVariant(expectation, variant)),
  );
  const errors = validate(rootRef, data).map((error) => ({
    ...error,
    instancePath: basePath + error.instancePath,
  }));

  expect(errors.length, "the fixture must be invalid").toBeGreaterThan(0);
  const reported = errors.map(describeError);
  for (const expectation of direct) {
    expect(
      errors.some((error) => matches(error, expectation)),
      `expected ${JSON.stringify(expectation)} among ${JSON.stringify(reported)}`,
    ).toBe(true);
  }
  const unattributed = errors.filter(
    (error) =>
      !direct.some((expectation) => matches(error, expectation)) &&
      !unions.some(
        (union) =>
          within(error.instancePath, union.instancePath) ||
          (unionKeywords.has(error.keyword) && within(union.instancePath, error.instancePath)),
      ),
  );
  expect(unattributed.map(describeError), "errors not attributable to the fixture's cause").toEqual(
    [],
  );

  for (const variant of variants) {
    const owned = expectations.filter((expectation) => inVariant(expectation, variant));
    expect(owned.length, `variant ${variant.via} needs nested expectations`).toBeGreaterThan(0);
    const node = resolvePointer(data, variant.instancePath.slice(basePath.length));
    assertExpectedFailure(
      validate,
      `${rootRef.split("#")[0]}#/$defs/${variant.via}`,
      node,
      owned,
      variant.instancePath,
    );
  }
}

export function testSchema(
  resourceName: string,
  schema: { $id: string },
  options: Omit<ValidatorOptions, "allErrors"> = {},
) {
  const validateFixture = createValidator(options).compile(schema);
  const diagnose = createValidator({ ...options, allErrors: true });
  diagnose.addSchema(schema);
  const validateRef = (schemaRef: string, data: unknown): ErrorObject[] => {
    const validate = diagnose.getSchema(schemaRef);
    if (!validate) throw new Error(`Unknown schema reference ${schemaRef}`);
    return validate(data) ? [] : (validate.errors ?? []);
  };

  describe(`${resourceName} schema`, () => {
    describe("valid fixtures", () => {
      const validPath = join(fixturesPath, resourceName, "valid");
      for (const file of listYamlFiles(validPath)) {
        test(file, () => {
          const documents = parseFixture(join(validPath, file));
          for (const data of documents) {
            const result = validateFixture(data);
            if (!result) {
              console.error(validateFixture.errors);
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
          const path = join(invalidPath, file);
          const expectations = parseExpectations(readFileSync(path, "utf-8"));
          expect(expectations.length, "invalid fixtures declare `# expect:` lines").toBeGreaterThan(
            0,
          );
          for (const data of parseFixture(path)) {
            expect(validateFixture(data)).toBe(false);
            assertExpectedFailure(validateRef, schema.$id, data, expectations);
          }
        });
      }
    });
  });
}
