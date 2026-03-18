import type { JSONSchema, FromSchema } from "json-schema-to-ts";

export const personSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/person.json",
  title: "Person",
  description: "A person in the system (author, instructor, etc.)",
  type: "object",
  properties: {
    apiVersion: {
      type: "string",
      const: "v1",
      description: "API version",
    },
    type: {
      type: "string",
      const: "Person",
      description: "Resource type",
    },
    name: {
      type: "string",
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      maxLength: 63,
      description: "Unique resource name (DNS-1123 subdomain)",
    },
    labels: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Key-value labels for organization",
    },
    spec: {
      type: "object",
      properties: {
        name: {
          type: "string",
          maxLength: 128,
          description: "Display name of the person",
        },
        email: {
          type: ["string", "null"],
          maxLength: 320,
          format: "email",
          description: "Email address",
        },
        bio: {
          type: ["string", "null"],
          description: "Biography or description",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  required: ["apiVersion", "type", "name", "spec"],
  additionalProperties: false,
} as const satisfies JSONSchema;

export type Person = FromSchema<typeof personSchema>;
