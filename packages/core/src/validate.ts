import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import courseV1Schema from "@topik/schema/course/v1.json" with { type: "json" };
import courseModuleV1Schema from "@topik/schema/course-module/v1.json" with { type: "json" };
import coursePageV1Schema from "@topik/schema/course-page/v1.json" with { type: "json" };
import guideV1Schema from "@topik/schema/guide/v1.json" with { type: "json" };
import personV1Schema from "@topik/schema/person/v1.json" with { type: "json" };
import wikiV1Schema from "@topik/schema/wiki/v1.json" with { type: "json" };
import wikiPageV1Schema from "@topik/schema/wiki-page/v1.json" with { type: "json" };
import { validateTopikContent } from "@topik/content";
import { validateAssetValue } from "./assets/asset";
import type { TopikAssetDiagnosticId } from "./assets/diagnostics";

// Report every schema violation in a resource, not only the first one.
const ajv = new Ajv2020({
  strict: true,
  discriminator: true,
  ownProperties: true,
  allErrors: true,
});
addFormats(ajv);

const validators = new Map<string, ReturnType<typeof ajv.compile>>([
  ["Course/v1", ajv.compile(courseV1Schema)],
  ["CourseModule/v1", ajv.compile(courseModuleV1Schema)],
  ["CoursePage/v1", ajv.compile(coursePageV1Schema)],
  ["Guide/v1", ajv.compile(guideV1Schema)],
  ["Person/v1", ajv.compile(personV1Schema)],
  ["Wiki/v1", ajv.compile(wikiV1Schema)],
  ["WikiPage/v1", ajv.compile(wikiPageV1Schema)],
]);

export interface ValidationError {
  id?:
    | "resource-invalid"
    | "resource-unsupported-type"
    | "resource-unsupported-version"
    | "resource-duplicate"
    | "reference-unresolved"
    | "order-duplicate"
    | "content-invalid"
    | TopikAssetDiagnosticId;
  resource: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getResourceLabel(resource: Record<string, unknown>): string {
  const type =
    Object.hasOwn(resource, "type") && typeof resource.type === "string"
      ? resource.type
      : "unknown";
  const name =
    Object.hasOwn(resource, "name") && typeof resource.name === "string"
      ? resource.name
      : "unknown";
  return `${type}/${name}`;
}

/** Validate the resources produced by `compile` and the CLI export. */
export function validateResources(resources: readonly unknown[]): ValidationResult {
  const errors: ValidationError[] = [];

  for (const resource of resources) {
    if (!isRecord(resource)) {
      errors.push({
        id: "resource-invalid",
        resource: "unknown/unknown",
        path: "/",
        message: "Resource must be an object",
      });
      continue;
    }

    if (!Object.hasOwn(resource, "type") || typeof resource.type !== "string") {
      errors.push({
        id: "resource-invalid",
        resource: getResourceLabel(resource),
        path: "/type",
        message: "Resource type must be a string",
      });
      continue;
    }

    const supportedType = [
      "Asset",
      "Course",
      "CourseModule",
      "CoursePage",
      "Guide",
      "Person",
      "Wiki",
      "WikiPage",
    ].includes(resource.type);
    if (!supportedType) {
      errors.push({
        id: "resource-unsupported-type",
        resource: getResourceLabel(resource),
        path: "/type",
        message: `Unsupported resource type: ${resource.type}`,
      });
      continue;
    }

    if (!Object.hasOwn(resource, "apiVersion") || typeof resource.apiVersion !== "string") {
      errors.push({
        id: "resource-invalid",
        resource: getResourceLabel(resource),
        path: "/apiVersion",
        message: "Resource apiVersion must be a string",
      });
      continue;
    }

    if (resource.type === "Asset") {
      const validation = validateAssetValue(resource);
      if (!validation.ok) {
        for (const diagnostic of validation.diagnostics) {
          errors.push({
            id: diagnostic.id,
            resource: getResourceLabel(resource),
            path: diagnostic.location.jsonPointer ?? "/",
            message: diagnostic.message,
          });
        }
      }
      continue;
    }

    const validate = validators.get(`${resource.type}/${resource.apiVersion}`);
    if (!validate) {
      errors.push({
        id: "resource-unsupported-version",
        resource: getResourceLabel(resource),
        path: "/apiVersion",
        message: `Unsupported ${resource.type} apiVersion: ${resource.apiVersion}`,
      });
      continue;
    }

    if (!validate(resource)) {
      for (const err of validate.errors ?? []) {
        errors.push({
          id: "resource-invalid",
          resource: getResourceLabel(resource),
          path: err.instancePath || "/",
          message: err.message ?? "Unknown error",
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function isResourceName(value: string): boolean {
  return value.length <= 63 && RESOURCE_NAME.test(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function ownRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const value = ownValue(record, key);
  return isRecord(value) && !Array.isArray(value) ? value : undefined;
}

/** A graph diagnostic, with the position of the resource it belongs to in the input. */
export interface ResourceGraphError extends ValidationError {
  id: "resource-duplicate" | "reference-unresolved" | "order-duplicate";
  /** Index of the resource this error belongs to in the validated list. */
  index: number;
}

export interface ResourceGraphResult {
  valid: boolean;
  errors: ResourceGraphError[];
}

/**
 * Check a complete set of resources against each other: each `type/name` is unique and each
 * by-name reference names a resource in the set. The references checked are a Wiki navigation
 * page entry to its WikiPage, a WikiPage to its Wiki, a CourseModule to its Course, a CoursePage
 * to its CourseModule, and each `spec.authors` entry of a Course, CoursePage or Guide to a Person.
 * The modules of one Course, and the pages of one module, must have distinct `spec.order` values.
 *
 * Run it only on a complete set, such as a whole compilation output: a partial set reports each
 * reference to a resource it leaves out. It does not check schemas. Resources that are not
 * objects or lack a string `type` and `name` are skipped, and only string references are checked.
 * Errors are ordered by resource index; a duplicate is reported on each repeat after the first.
 */
export function validateResourceGraph(resources: readonly unknown[]): ResourceGraphResult {
  const errors: ResourceGraphError[] = [];
  const byKey = new Map<string, Record<string, unknown>>();
  const entries: {
    index: number;
    resource: Record<string, unknown>;
    type: string;
    name: string;
  }[] = [];

  resources.forEach((resource, index) => {
    if (!isRecord(resource)) return;
    const type = ownValue(resource, "type");
    const name = ownValue(resource, "name");
    if (typeof type !== "string" || typeof name !== "string") return;
    const key = `${type}/${name}`;
    if (byKey.has(key)) {
      errors.push({
        id: "resource-duplicate",
        index,
        resource: key,
        path: "/name",
        message: "must be unique: another resource has the same type and name",
      });
      return;
    }
    byKey.set(key, resource);
    entries.push({ index, resource, type, name });
  });

  // Names are input text; only schema-valid names are repeated in a message.
  const target = (type: string, name: string) =>
    isResourceName(name) ? `${type}/${name}` : `the ${type}`;

  // Course order is defined by `spec.order` alone, so siblings must not share a value.
  const siblingOrders = new Map<string, Set<number>>();
  for (const { index, resource, type, name } of entries) {
    const label = `${type}/${name}`;
    const parent =
      type === "CourseModule" ? "course" : type === "CoursePage" ? "module" : undefined;
    const orderSpec = parent ? ownRecord(resource, "spec") : undefined;
    const parentName = orderSpec ? ownValue(orderSpec, parent!) : undefined;
    const order = orderSpec ? ownValue(orderSpec, "order") : undefined;
    if (typeof parentName === "string" && typeof order === "number") {
      const key = `${type}:${parentName}`;
      const orders = siblingOrders.get(key) ?? new Set<number>();
      siblingOrders.set(key, orders);
      if (orders.has(order))
        errors.push({
          id: "order-duplicate",
          index,
          resource: label,
          path: "/spec/order",
          message: `must be unique: another ${type} in the same ${parent === "course" ? "Course" : "CourseModule"} has the same order`,
        });
      orders.add(order);
    }
    const spec = ownRecord(resource, "spec");
    if (!spec) continue;

    const reference = (path: string, targetType: string, targetName: unknown) => {
      if (typeof targetName !== "string" || byKey.has(`${targetType}/${targetName}`)) return;
      errors.push({
        id: "reference-unresolved",
        index,
        resource: label,
        path,
        message: `must reference a ${targetType} in the resource set; ${target(targetType, targetName)} is missing`,
      });
    };

    switch (type) {
      case "CourseModule":
        reference("/spec/course", "Course", ownValue(spec, "course"));
        break;
      case "CoursePage":
        reference("/spec/module", "CourseModule", ownValue(spec, "module"));
        break;
      case "WikiPage":
        reference("/spec/wiki", "Wiki", ownValue(spec, "wiki"));
        break;
      case "Wiki": {
        const navigation = ownValue(spec, "navigation");
        if (!Array.isArray(navigation)) break;
        visitWikiNavigationPages(navigation, "/spec/navigation", (path, page) =>
          reference(path, "WikiPage", page),
        );
        break;
      }
    }

    if (type === "Course" || type === "CoursePage" || type === "Guide") {
      const authors = ownValue(spec, "authors");
      if (Array.isArray(authors)) {
        authors.forEach((author, position) =>
          reference(`/spec/authors/${position}`, "Person", author),
        );
      }
    }
  }

  errors.sort((left, right) => left.index - right.index);
  return { valid: errors.length === 0, errors };
}

/**
 * Call `visit` with the JSON pointer and page name of each page entry in a navigation tree.
 * An array that contains itself (a circular YAML alias) is entered once per path.
 */
function visitWikiNavigationPages(
  nodes: readonly unknown[],
  pointer: string,
  visit: (path: string, page: string) => void,
  active = new Set<readonly unknown[]>(),
): void {
  if (active.has(nodes)) return;
  active.add(nodes);
  nodes.forEach((node, position) => {
    if (!isRecord(node) || Array.isArray(node)) return;
    const path = `${pointer}/${position}`;
    const page = ownValue(node, "page");
    if (ownValue(node, "type") === "page" && typeof page === "string") visit(`${path}/page`, page);
    const children = ownValue(node, "children");
    if (Array.isArray(children)) {
      visitWikiNavigationPages(children, `${path}/children`, visit, active);
    }
  });
  active.delete(nodes);
}

const CONTENT_RESOURCE_TYPES = new Set(["CoursePage", "Guide", "WikiPage"]);

/**
 * Check `spec.content.value` of each CoursePage, Guide and WikiPage whose content format is
 * `topik`, with the `@topik/content` source admission that compilation uses and accepting the
 * Asset references compilation produces. Each error-level content diagnostic becomes a
 * `content-invalid` error at `/spec/content/value`, prefixed with its one-based line when known.
 * Other resources, other content formats and non-string content are skipped; schema validation
 * reports those.
 */
export function validateResourceContent(resources: readonly unknown[]): ValidationResult {
  const errors: ValidationError[] = [];
  for (const resource of resources) {
    if (!isRecord(resource)) continue;
    const type = ownValue(resource, "type");
    if (typeof type !== "string" || !CONTENT_RESOURCE_TYPES.has(type)) continue;
    const content = ownRecord(ownRecord(resource, "spec"), "content");
    if (!content || ownValue(content, "format") !== "topik") continue;
    const value = ownValue(content, "value");
    if (typeof value !== "string") continue;
    const validation = validateTopikContent(value, { allowCompiledAssetReferences: true });
    for (const diagnostic of validation.errors) {
      if (diagnostic.level !== "error" && diagnostic.level !== "critical") continue;
      const line = diagnostic.lines[0];
      errors.push({
        id: "content-invalid",
        resource: getResourceLabel(resource),
        path: "/spec/content/value",
        message: line === undefined ? diagnostic.message : `line ${line}: ${diagnostic.message}`,
      });
    }
  }
  return { valid: errors.length === 0, errors };
}
