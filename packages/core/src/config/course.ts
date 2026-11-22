import { z } from "zod";
import { sourceAssetsConfigSchema, DEFAULT_ASSET_DIRECTORY } from "./assets";
import { rejectMisspelledKeys } from "./misspelled-keys";
import {
  pageSourcePathSchema,
  movedPersonsSchema,
  resourceNameSchema,
  slugSchema,
  sourceLabelsSchema,
} from "./source-metadata";
import { validateCoursePageSources } from "../course-navigation";

const name = resourceNameSchema;
const slug = slugSchema;
const title = z.string().min(1).max(256);
// Order comes from list position, as in Wiki navigation. An `order` key from an older source
// is refused rather than ignored, so a list that disagrees with it cannot silently reorder.
const noOrder = z.never({ error: "Order comes from list position; remove `order`" }).optional();
const authors = z.array(name).max(1_000);

const moduleSchema = z.object({
  id: name,
  title,
  slug,
  order: noOrder,
  description: z.string().max(1024).nullable().optional(),
  labels: sourceLabelsSchema.optional(),
  pages: z.array(pageSourcePathSchema).max(10_000),
});

const courseConfigSchema = z
  .object({
    id: name,
    title,
    slug,
    description: z.string().max(1024).nullable().optional(),
    labels: sourceLabelsSchema.optional(),
    authors: authors.optional(),
    persons: movedPersonsSchema,
    assets: sourceAssetsConfigSchema.default({ directory: DEFAULT_ASSET_DIRECTORY }),
    modules: z.array(moduleSchema).max(1_000),
  })
  .superRefine((config, context) => {
    const paths = config.modules.flatMap((module) => module.pages);
    const unique = (values: readonly string[]) => new Set(values).size === values.length;
    if (
      paths.length > 10_000 ||
      !unique(config.modules.map((module) => module.id)) ||
      !unique(config.modules.map((module) => module.slug)) ||
      !unique(paths) ||
      !validateCoursePageSources(paths)
    )
      context.addIssue({
        code: "custom",
        message: "Course modules and page sources must be unique and portable",
      });
  });

const coursePageMetadataSchema = z.object({
  id: name,
  title,
  slug,
  order: noOrder,
  description: z.string().max(1024).nullable().optional(),
  authors: authors.optional(),
  labels: sourceLabelsSchema.optional(),
});

export type CourseConfig = Omit<z.infer<typeof courseConfigSchema>, "persons">;
export type CourseModuleConfig = z.infer<typeof moduleSchema>;

export function parseCourseConfig(raw: unknown): CourseConfig {
  rejectMisspelledKeys(raw, Object.keys(courseConfigSchema.shape));
  const modules = (raw as { modules?: unknown } | null)?.modules;
  if (Array.isArray(modules))
    modules.forEach((module, index) =>
      rejectMisspelledKeys(module, Object.keys(moduleSchema.shape), ["modules", index]),
    );
  const { persons: _, ...config } = courseConfigSchema.parse(raw);
  return config;
}

export function parseCoursePageMetadata(raw: unknown) {
  return coursePageMetadataSchema.parse(raw);
}
