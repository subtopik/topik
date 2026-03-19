import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { wikiSchema, wikiPageSchema } from "@topik/schema";
import type { ResourceType } from "./resource";

const ajv = new Ajv2020({ strict: true, discriminator: true });
addFormats(ajv);

const validators: Record<ResourceType, ReturnType<typeof ajv.compile>> = {
  Wiki: ajv.compile(wikiSchema),
  WikiPage: ajv.compile(wikiPageSchema),
};

export interface ValidationError {
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
  const type = typeof resource.type === "string" ? resource.type : "unknown";
  const name = typeof resource.name === "string" ? resource.name : "unknown";
  return `${type}/${name}`;
}

/** Validate the wiki resources produced by `compile` and the CLI export. */
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

    if (typeof resource.type !== "string") {
      errors.push({
        resource: getResourceLabel(resource),
        path: "/type",
        message: "Resource type must be a string",
      });
      continue;
    }

    const validate = validators[resource.type as ResourceType];
    if (!validate) {
      errors.push({
        resource: getResourceLabel(resource),
        path: "/type",
        message: `Unsupported resource type: ${resource.type}`,
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
