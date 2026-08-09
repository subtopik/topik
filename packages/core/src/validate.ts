import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  courseModuleSchema,
  coursePageSchema,
  courseSchema,
  guideSchema,
  personSchema,
  wikiPageSchema,
  wikiSchema,
} from "@topik/schema";
import { validateAssetValue } from "./portable/asset";

const ajv = new Ajv2020({ strict: true, discriminator: true, ownProperties: true });
addFormats(ajv);

const validators = new Map<string, ReturnType<typeof ajv.compile>>([
  ["Course/v1", ajv.compile(courseSchema)],
  ["CourseModule/v1", ajv.compile(courseModuleSchema)],
  ["CoursePage/v1", ajv.compile(coursePageSchema)],
  ["Guide/v1", ajv.compile(guideSchema)],
  ["Person/v1", ajv.compile(personSchema)],
  ["Wiki/v1", ajv.compile(wikiSchema)],
  ["WikiPage/v1", ajv.compile(wikiPageSchema)],
]);

export interface ValidationError {
  id?: "resource-invalid" | "resource-unsupported-type" | "resource-unsupported-version";
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
        resource: "unknown/unknown",
        path: "/",
        message: "Resource must be an object",
      });
      continue;
    }

    if (!Object.hasOwn(resource, "type") || typeof resource.type !== "string") {
      errors.push({
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
        resource: getResourceLabel(resource),
        path: "/type",
        message: `Unsupported resource type: ${resource.type}`,
      });
      continue;
    }

    if (!Object.hasOwn(resource, "apiVersion") || typeof resource.apiVersion !== "string") {
      errors.push({
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
            ...(diagnostic.id === "TOPIK_ASSET_UNSUPPORTED_VERSION"
              ? { id: "resource-unsupported-version" as const }
              : {}),
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
          resource: getResourceLabel(resource),
          path: err.instancePath || "/",
          message: err.message ?? "Unknown error",
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
