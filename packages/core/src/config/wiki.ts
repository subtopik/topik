import { z } from "zod";

export type WikiNavNode =
  | string
  | { group: string; slug?: string; icon?: string; children: WikiNavNode[] }
  | { tab: string; slug?: string; icon?: string; children: WikiNavNode[] }
  | { href: string; title: string; icon?: string };

const wikiPagePath = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(?:[a-z0-9]+(?:-[a-z0-9]+)*))*$/,
    "Wiki page paths must use lowercase DNS-style segments separated by '/'",
  );

const navNodeSchema: z.ZodType<WikiNavNode, z.ZodTypeDef, unknown> = z.union([
  wikiPagePath,
  z.object({
    group: z.string().min(1).max(256),
    slug: z.string().min(1).max(256).optional(),
    icon: z.string().min(1).max(256).optional(),
    children: z.lazy(() => z.array(navNodeSchema)).default([]),
  }),
  z.object({
    tab: z.string().min(1).max(256),
    slug: z.string().min(1).max(256).optional(),
    icon: z.string().min(1).max(256).optional(),
    children: z.lazy(() => z.array(navNodeSchema)).default([]),
  }),
  z.object({
    href: z
      .string()
      .max(2048)
      .refine((v) => v.startsWith("https://") || v.startsWith("http://"), {
        message: "href must be an http or https URL",
      }),
    title: z.string().min(1).max(256),
    icon: z.string().min(1).max(256).optional(),
  }),
]);

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

const wikiConfigSchema = z.object({
  id: z.string().min(1).max(63).regex(nameRegex),
  title: z.string().min(1).max(256),
  navigation: z.array(navNodeSchema).optional(),
  theme: themeSchema.optional(),
});

export type WikiConfig = z.infer<typeof wikiConfigSchema>;

export function parseWikiConfig(raw: unknown): WikiConfig {
  return wikiConfigSchema.parse(raw);
}
