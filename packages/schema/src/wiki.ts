export const wikiSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://topik.dev/schemas/wiki.json",
  title: "Wiki",
  description: "A documentation site/wiki resource",
  type: "object",
  properties: {
    apiVersion: {
      type: "string",
      const: "v1",
      description: "API version",
    },
    type: {
      type: "string",
      const: "Wiki",
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
          description: "Title of the wiki",
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
          description: "Description of the wiki",
        },
        navigation: {
          type: "array",
          items: { $ref: "#/$defs/navNode" },
          description: "Navigation tree for the wiki",
        },
      },
      required: ["title", "slug"],
      additionalProperties: false,
    },
  },
  required: ["apiVersion", "type", "name", "spec"],
  additionalProperties: false,
  $defs: {
    navNode: {
      type: "object",
      discriminator: { propertyName: "type" },
      oneOf: [
        {
          type: "object",
          properties: {
            type: { type: "string", const: "group" },
            title: { type: "string", maxLength: 256 },
            slug: { type: "string", maxLength: 256, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            icon: { type: "string", maxLength: 256, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            expanded: { type: "boolean" },
            hidden: { type: "boolean" },
            children: { type: "array", items: { $ref: "#/$defs/navNode" } },
          },
          required: ["type", "title", "slug", "children"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { type: "string", const: "page" },
            page: {
              type: "string",
              pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
              maxLength: 63,
              description: "Reference to a WikiPage by name",
            },
            slug: { type: "string", maxLength: 256, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            icon: { type: "string", maxLength: 256, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            hidden: { type: "boolean" },
          },
          required: ["type", "page", "slug"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { type: "string", const: "link" },
            title: { type: "string", maxLength: 256 },
            icon: { type: "string", maxLength: 256, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            hidden: { type: "boolean" },
            href: { type: "string", maxLength: 2048 },
          },
          required: ["type", "title", "href"],
          additionalProperties: false,
        },
      ],
    },
  },
} as const;

export type WikiNavNode =
  | {
      type: "group";
      id?: string;
      title: string;
      slug: string;
      icon?: string;
      expanded?: boolean;
      hidden?: boolean;
      children: WikiNavNode[];
    }
  | { type: "page"; page: string; slug: string; icon?: string; hidden?: boolean }
  | { type: "link"; title: string; icon?: string; hidden?: boolean; href: string };

export type Wiki = {
  apiVersion: "v1";
  type: "Wiki";
  name: string;
  labels?: Record<string, string>;
  spec: {
    title: string;
    slug: string;
    description?: string | null;
    navigation?: WikiNavNode[];
  };
};
