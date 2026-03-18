import type { JSONSchema, FromSchema } from "json-schema-to-ts";

export const courseModuleSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/course-module.json",
  title: "CourseModule",
  description: "A module within a course",
  type: "object",
  properties: {
    apiVersion: {
      type: "string",
      const: "v1",
      description: "API version",
    },
    type: {
      type: "string",
      const: "CourseModule",
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
        course: {
          type: "string",
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          maxLength: 63,
          description: "Reference to a Course by name",
        },
        title: {
          type: "string",
          maxLength: 256,
          description: "Module title",
        },
        slug: {
          type: "string",
          maxLength: 256,
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          description: "URL-friendly slug",
        },
        order: {
          type: "integer",
          minimum: 0,
          description: "Order of the module within the course",
        },
        description: {
          type: ["string", "null"],
          maxLength: 1024,
          description: "Description of the module",
        },
      },
      required: ["course", "title", "slug", "order"],
      additionalProperties: false,
    },
  },
  required: ["apiVersion", "type", "name", "spec"],
  additionalProperties: false,
} as const satisfies JSONSchema;

export type CourseModule = FromSchema<typeof courseModuleSchema>;
