import type { JSONSchema, FromSchema } from "json-schema-to-ts";

/** Guide v2 removes the legacy digest-name list from `spec.assets`. */
export const guideV2Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/guide/v2.json",
  title: "Guide v2",
  type: "object",
  properties: {
    apiVersion: { const: "v2" },
    type: { const: "Guide" },
    name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 63 },
    labels: { type: "object", additionalProperties: { type: "string" } },
    spec: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 256 },
        slug: {
          type: "string",
          maxLength: 256,
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        },
        description: { type: ["string", "null"], maxLength: 512 },
        authors: {
          type: "array",
          items: {
            type: "string",
            pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            maxLength: 63,
          },
        },
        tags: { type: "array", items: { type: "string", minLength: 1, maxLength: 63 } },
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
      required: ["title", "slug", "content"],
      additionalProperties: false,
    },
  },
  required: ["apiVersion", "type", "name", "spec"],
  additionalProperties: false,
} as const satisfies JSONSchema;

export type GuideV2 = FromSchema<typeof guideV2Schema>;
