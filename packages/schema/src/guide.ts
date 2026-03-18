import type { JSONSchema, FromSchema } from "json-schema-to-ts";

export const guideSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/guide.json",
  title: "Guide",
  description: "A guide/tutorial resource with content",
  type: "object",
  properties: {
    apiVersion: {
      type: "string",
      const: "v1",
      description: "API version",
    },
    type: {
      type: "string",
      const: "Guide",
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
          description: "Title of the guide",
        },
        slug: {
          type: "string",
          maxLength: 256,
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          description: "URL-friendly slug",
        },
        description: {
          type: ["string", "null"],
          maxLength: 512,
          description: "Short description of the guide",
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
              description: "Guide content in the specified format",
            },
          },
          required: ["format", "value"],
          additionalProperties: false,
        },
      },
      required: ["title", "slug", "content"],
      additionalProperties: false,
    },
  },
  required: ["apiVersion", "type", "name", "spec"],
  additionalProperties: false,
} as const satisfies JSONSchema;

export type Guide = FromSchema<typeof guideSchema>;
