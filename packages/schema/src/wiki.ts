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
        theme: { $ref: "#/$defs/theme" },
      },
      required: ["title"],
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
            slug: { type: "string", maxLength: 256, pattern: "^[a-z0-9]+(?:[-/][a-z0-9]+)*$" },
            icon: { type: "string", maxLength: 256, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            expanded: { type: "boolean" },
            hidden: { type: "boolean" },
            children: { type: "array", items: { $ref: "#/$defs/navNode" } },
          },
          required: ["type", "title", "children"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { type: "string", const: "tab" },
            title: { type: "string", maxLength: 256 },
            slug: { type: "string", maxLength: 256, pattern: "^[a-z0-9]+(?:[-/][a-z0-9]+)*$" },
            icon: { type: "string", maxLength: 256, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            children: { type: "array", items: { $ref: "#/$defs/navNode" } },
          },
          required: ["type", "title", "children"],
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
            slug: {
              type: "string",
              maxLength: 512,
              pattern: "^([a-z0-9]+(?:[-/][a-z0-9]+)*)?$",
              description: "URL path for the page",
            },
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
    theme: {
      type: "object",
      properties: {
        colors: {
          type: "object",
          properties: {
            primary: {
              type: "string",
              pattern: "^#[0-9a-fA-F]{6}$",
              description: "Primary theme color",
            },
            light: {
              type: "string",
              pattern: "^#[0-9a-fA-F]{6}$",
              description: "Light mode color override",
            },
            dark: {
              type: "string",
              pattern: "^#[0-9a-fA-F]{6}$",
              description: "Dark mode color override",
            },
          },
          required: ["primary"],
          additionalProperties: false,
        },
        appearance: {
          type: "object",
          properties: {
            default: {
              type: "string",
              enum: ["light", "dark", "system"],
              description: "Default color scheme",
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
      description: "Theme configuration",
    },
  },
} as const;

export type WikiNavNode =
  | {
      type: "group";
      title: string;
      slug?: string;
      icon?: string;
      expanded?: boolean;
      hidden?: boolean;
      children: WikiNavNode[];
    }
  | {
      type: "tab";
      title: string;
      slug?: string;
      icon?: string;
      children: WikiNavNode[];
    }
  | { type: "page"; page: string; slug: string; icon?: string; hidden?: boolean }
  | { type: "link"; title: string; icon?: string; hidden?: boolean; href: string };

export type WikiTheme = {
  colors?: {
    primary: string;
    light?: string;
    dark?: string;
  };
  appearance?: {
    default?: "light" | "dark" | "system";
  };
};

export type Wiki = {
  apiVersion: "v1";
  type: "Wiki";
  name: string;
  labels?: Record<string, string>;
  spec: {
    title: string;
    description?: string | null;
    navigation?: WikiNavNode[];
    theme?: WikiTheme;
  };
};
