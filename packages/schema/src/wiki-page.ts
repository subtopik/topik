import type { JSONSchema, FromSchema } from "json-schema-to-ts";

export const wikiPageSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/wiki-page.json",
  title: "WikiPage",
  description: "A content page within a wiki",
  type: "object",
  properties: {
    apiVersion: {
      type: "string",
      const: "v1",
      description: "API version",
    },
    type: {
      type: "string",
      const: "WikiPage",
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
        wiki: {
          type: "string",
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          maxLength: 63,
          description: "Reference to a Wiki by name",
        },
        title: {
          type: "string",
          maxLength: 256,
          description: "Page title",
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
      required: ["wiki", "title", "content"],
      additionalProperties: false,
    },
  },
  required: ["apiVersion", "type", "name", "spec"],
  additionalProperties: false,
} as const satisfies JSONSchema;

export type WikiPage = FromSchema<typeof wikiPageSchema>;
