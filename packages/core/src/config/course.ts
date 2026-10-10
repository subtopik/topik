import { z } from "zod";
import { sourceAssetsConfigSchema, DEFAULT_ASSET_DIRECTORY } from "./assets";
import { pageSourcePathSchema, parseSourcePersons, sourceLabelsSchema } from "./source-version";
import { validateCoursePageSources } from "../course-navigation";

const name = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const slug = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const title = z.string().min(1).max(256);
const order = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const authors = z.array(name).max(1_000);

const moduleSchema = z.object({
  id: name,
  title,
  slug,
  order,
  description: z.string().max(1024).nullable().optional(),
  labels: sourceLabelsSchema.optional(),
  pages: z.array(pageSourcePathSchema).max(10_000),
});

const courseConfigSchema = z
  .object({
    sourceVersion: z.literal(1),
    id: name,
    title,
    slug,
    description: z.string().max(1024).nullable().optional(),
    labels: sourceLabelsSchema.optional(),
    authors: authors.optional(),
    persons: z.unknown().optional(),
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
  order,
  authors: authors.optional(),
  labels: sourceLabelsSchema.optional(),
});

export type CourseConfig = Omit<z.infer<typeof courseConfigSchema>, "persons"> & {
  persons?: ReturnType<typeof parseSourcePersons>;
};
export type CourseModuleConfig = z.infer<typeof moduleSchema>;

export function parseCourseConfig(raw: unknown): CourseConfig {
  const config = courseConfigSchema.parse(raw);
  const { persons, ...rest } = config;
  return { ...rest, ...(persons !== undefined ? { persons: parseSourcePersons(persons) } : {}) };
}

export function parseCoursePageMetadata(raw: unknown) {
  return coursePageMetadataSchema.parse(raw);
}
