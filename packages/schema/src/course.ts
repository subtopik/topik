import type { JSONSchema, FromSchema } from "json-schema-to-ts";

export const courseSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/course.json",
  title: "Course",
  description: "A course resource",
  type: "object",
  properties: {
    apiVersion: {
      type: "string",
      const: "v1",
      description: "API version",
    },
    type: {
      type: "string",
      const: "Course",
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
        title: {
          type: "string",
          maxLength: 256,
          description: "Title of the course",
        },
        slug: {
          type: "string",
          maxLength: 256,
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          description: "URL-friendly slug",
        },
        description: {
          type: ["string", "null"],
          maxLength: 1024,
          description: "Description of the course",
        },
        authors: {
          type: "array",
          items: {
            type: "string",
            pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            maxLength: 63,
            description: "Reference to a Person by name",
          },
          description: "List of author references (Person names)",
        },
      },
      required: ["title", "slug"],
      additionalProperties: false,
    },
  },
  required: ["apiVersion", "type", "name", "spec"],
  additionalProperties: false,
} as const satisfies JSONSchema;

export type Course = FromSchema<typeof courseSchema>;
