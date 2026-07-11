import { z } from "zod";

type WikiPageNavNode = {
  type: "page";
  slug: string;
  icon?: string;
  hidden?: boolean;
};

type WikiGroupNavNode = {
  type: "group";
  title: string;
  slug?: string;
  icon?: string;
  expanded?: boolean;
  hidden?: boolean;
  children: WikiNavNode[];
};

type WikiInternalSwitcherNavNode = {
  type: "tab" | "dropdown";
  title: string;
  slug?: string;
  icon?: string;
  hidden?: boolean;
  children: WikiNavNode[];
};

type WikiExternalSwitcherNavNode = {
  type: "tab" | "dropdown";
  title: string;
  href: string;
  icon?: string;
  hidden?: boolean;
};

type WikiLinkNavNode = {
  type: "link";
  title: string;
  href: string;
  icon?: string;
  hidden?: boolean;
};

export type WikiNavNode =
  | string
  | WikiPageNavNode
  | WikiGroupNavNode
  | WikiInternalSwitcherNavNode
  | WikiExternalSwitcherNavNode
  | WikiLinkNavNode;

const pathSegment = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slugs must be lowercase DNS-style segments");

const wikiPagePath = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(?:[a-z0-9]+(?:-[a-z0-9]+)*))*$/,
    "Wiki page paths must use lowercase DNS-style segments separated by '/'",
  );

const title = z.string().min(1).max(256);
const icon = z.string().min(1).max(256).optional();
const href = z
  .string()
  .max(2048)
  .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
    message: "href must be an http or https URL",
  });

const navNodeSchema: z.ZodType<WikiNavNode> = z.lazy(() =>
  z.union([
    wikiPagePath,
    z
      .object({
        type: z.literal("page"),
        slug: wikiPagePath,
        icon,
        hidden: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("group"),
        title,
        slug: pathSegment.optional(),
        icon,
        expanded: z.boolean().optional(),
        hidden: z.boolean().optional(),
        children: z.array(navNodeSchema).default([]),
      })
      .strict(),
    z
      .object({
        type: z.union([z.literal("tab"), z.literal("dropdown")]),
        title,
        slug: pathSegment.optional(),
        icon,
        hidden: z.boolean().optional(),
        children: z.array(navNodeSchema).default([]),
      })
      .strict(),
    z
      .object({
        type: z.union([z.literal("tab"), z.literal("dropdown")]),
        title,
        href,
        icon,
        hidden: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("link"),
        title,
        href,
        icon,
        hidden: z.boolean().optional(),
      })
      .strict(),
  ]),
);

function nodeKind(node: WikiNavNode): "tab" | "dropdown" | "sidebar" {
  if (typeof node !== "string" && node.type === "tab") return "tab";
  if (typeof node !== "string" && node.type === "dropdown") return "dropdown";
  return "sidebar";
}

function validateHomogeneousLevel(
  nodes: WikiNavNode[],
  allowed: ReadonlySet<"tab" | "dropdown" | "sidebar">,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  const kinds = new Set(nodes.map(nodeKind));
  for (const kind of kinds) {
    if (!allowed.has(kind)) {
      context.addIssue({
        code: "custom",
        path,
        message: `Navigation ${kind} nodes are not allowed at this level`,
      });
    }
  }
  if (kinds.size > 1) {
    context.addIssue({
      code: "custom",
      path,
      message: "Navigation surfaces cannot be mixed at the same level",
    });
  }

  nodes.forEach((node, index) => {
    if (typeof node === "string" || !("children" in node)) return;
    const childPath = [...path, index, "children"];
    if (node.type === "tab") {
      validateHomogeneousLevel(node.children, new Set(["dropdown", "sidebar"]), childPath, context);
    } else {
      validateHomogeneousLevel(node.children, new Set(["sidebar"]), childPath, context);
    }
  });
}

function validateUniquePageRoutes(
  nodes: WikiNavNode[],
  path: Array<string | number>,
  context: z.RefinementCtx,
  prefix = "",
  routes = new Map<string, Array<string | number>>(),
): void {
  nodes.forEach((node, index) => {
    const nodePath = [...path, index];
    if (typeof node === "string" || node.type === "page") {
      const localPath = typeof node === "string" ? node : node.slug;
      const sourcePath = joinNavigationPath(prefix, localPath);
      const route = sourcePath === "index" ? "" : sourcePath.replace(/\/index$/, "");
      const previousPath = routes.get(route);
      if (previousPath) {
        context.addIssue({
          code: "custom",
          path: nodePath,
          message: `Navigation contains duplicate page route /${route}`,
        });
      } else {
        routes.set(route, nodePath);
      }
      return;
    }
    if ("children" in node) {
      validateUniquePageRoutes(
        node.children,
        [...nodePath, "children"],
        context,
        joinNavigationPath(prefix, node.slug),
        routes,
      );
    }
  });
}

function joinNavigationPath(prefix: string, path?: string): string {
  if (!path) return prefix;
  return prefix ? `${prefix}/${path}` : path;
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color (e.g. #ff73a8)");

const themeSchema = z.object({
  colors: z
    .object({
      primary: hexColor,
      light: hexColor.optional(),
      dark: hexColor.optional(),
    })
    .optional(),
  appearance: z
    .object({
      default: z.enum(["light", "dark", "system"]).optional(),
    })
    .optional(),
});

const nameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WIKI_PAGE_NAME_HASH_LENGTH = 16;
const RESOURCE_NAME_MAX_LENGTH = 63;
const MAX_WIKI_ID_FOR_PAGE_NAMES = RESOURCE_NAME_MAX_LENGTH - WIKI_PAGE_NAME_HASH_LENGTH - 1;

const wikiConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(
        MAX_WIKI_ID_FOR_PAGE_NAMES,
        `Wiki id must be ${MAX_WIKI_ID_FOR_PAGE_NAMES} characters or fewer`,
      )
      .regex(nameRegex),
    title: z.string().min(1).max(256),
    description: z.union([z.string().max(1024), z.null()]).optional(),
    navigation: z.array(navNodeSchema).optional(),
    theme: themeSchema.optional(),
  })
  .superRefine((config, context) => {
    if (config.navigation) {
      validateHomogeneousLevel(
        config.navigation,
        new Set(["tab", "dropdown", "sidebar"]),
        ["navigation"],
        context,
      );
      validateUniquePageRoutes(config.navigation, ["navigation"], context);
    }
  });

export type WikiConfig = z.infer<typeof wikiConfigSchema>;

export function parseWikiConfig(raw: unknown): WikiConfig {
  return wikiConfigSchema.parse(raw);
}
