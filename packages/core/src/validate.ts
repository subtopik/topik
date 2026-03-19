import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { wikiSchema, wikiPageSchema } from "@topik/schema";
import type { Resource } from "./compile/wiki";

const ajv = new Ajv2020({ strict: true, discriminator: true });
addFormats(ajv);

const validators: Record<string, ReturnType<typeof ajv.compile>> = {
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

export function validateResources(resources: Resource[]): ValidationResult {
  const errors: ValidationError[] = [];

  for (const resource of resources) {
    const validate = validators[resource.type];
    if (!validate) continue;

    if (!validate(resource)) {
      for (const err of validate.errors ?? []) {
        errors.push({
          resource: `${resource.type}/${resource.name}`,
          path: err.instancePath,
          message: err.message ?? "Unknown error",
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
