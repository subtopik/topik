import type { JSONSchema, FromSchema } from "json-schema-to-ts";

export const coursePageSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/course-page.json",
  title: "CoursePage",
  description: "A content page within a course module",
  type: "object",
  properties: {
    apiVersion: {
      type: "string",
      const: "v1",
      description: "API version",
    },
    type: {
      type: "string",
      const: "CoursePage",
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
        module: {
          type: "string",
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          maxLength: 63,
          description: "Reference to a CourseModule by name",
        },
        title: {
          type: "string",
          maxLength: 256,
          description: "Page title",
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
          description: "Order of the page within the module",
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
        content: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["topik", "other"],
              description: "Format of the content value",
            },
            value: {
              type: "string",
              description: "Page content in the specified format",
            },
          },
          required: ["format", "value"],
          additionalProperties: false,
        },
      },
      required: ["module", "title", "slug", "order", "content"],
      additionalProperties: false,
    },
  },
  required: ["apiVersion", "type", "name", "spec"],
  additionalProperties: false,
} as const satisfies JSONSchema;

export type CoursePage = FromSchema<typeof coursePageSchema>;
