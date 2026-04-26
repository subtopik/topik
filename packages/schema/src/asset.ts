import type { JSONSchema, FromSchema } from "json-schema-to-ts";

export const assetSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/asset.json",
  title: "Asset",
  description: "A binary asset referenced by content (image, video, etc.)",
  type: "object",
  properties: {
    apiVersion: {
      type: "string",
      const: "v1",
      description: "API version",
    },
    type: {
      type: "string",
      const: "Asset",
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
        uri: {
          type: "string",
          maxLength: 1024,
          description:
            "URI reference to the asset (RFC 3986). Relative refs are resolved against the compilation directory; absolute URIs (e.g. https://) point to remote assets.",
        },
        mediaType: {
          type: "string",
          maxLength: 128,
          description:
            "IANA media type of the asset (RFC 6838). Optional: consumers may infer from the URI extension or by content sniffing when absent.",
        },
        integrity: {
          type: "string",
          pattern: "^sha256-[A-Za-z0-9+/]{43}=$",
          description: "Subresource Integrity hash (sha256, base64-encoded)",
        },
      },
      required: ["uri", "integrity"],
      additionalProperties: false,
    },
  },
  required: ["apiVersion", "type", "name", "spec"],
  additionalProperties: false,
} as const satisfies JSONSchema;

export type Asset = FromSchema<typeof assetSchema>;
