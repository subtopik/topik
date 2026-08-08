import type { JSONSchema, FromSchema } from "json-schema-to-ts";

/** WikiPage v2 removes the legacy digest-name list from `spec.assets`. */
export const wikiPageV2Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/wiki-page/v2.json",
  title: "WikiPage v2",
  type: "object",
  properties: {
    apiVersion: { const: "v2" },
    type: { const: "WikiPage" },
    name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 63 },
    labels: { type: "object", additionalProperties: { type: "string" } },
    spec: {
      type: "object",
      properties: {
        wiki: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 63 },
        title: { type: "string", maxLength: 256 },
        description: { type: ["string", "null"], maxLength: 1024 },
        content: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["topik", "other"] },
            value: { type: "string" },
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

export type WikiPageV2 = FromSchema<typeof wikiPageV2Schema>;
