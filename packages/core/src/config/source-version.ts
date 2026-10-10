import { z } from "zod";
import type { Person } from "@topik/schema/person/v1";
import { validateResources } from "../validate";
import { validateTopikPath } from "../assets/path";

export const sourceVersionSchema = z.literal(1).optional();
export const sourceLabelsSchema = z.record(z.string(), z.string());
const name = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const pageSourcePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => validateTopikPath(value).ok && !/\.(?:mdx?|markdown)$/i.test(value),
    "Page sources must be portable config-relative paths without a Markdown extension",
  );

const pageMetadataSchema = z.object({
  id: name.optional(),
  title: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).nullable().optional(),
  labels: sourceLabelsSchema.optional(),
});
const guideMetadataSchema = pageMetadataSchema.extend({
  slug: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  description: z.string().max(512).nullable().optional(),
  authors: z.array(name).optional(),
  tags: z.array(z.string().min(1).max(63)).optional(),
  inheritTags: z.boolean().optional(),
});

export function parsePageMetadata(value: unknown) {
  return pageMetadataSchema.parse(value);
}
export function parseGuideMetadata(value: unknown) {
  return guideMetadataSchema.parse(value);
}

/** The public resource validator owns Person fields, including future schema additions. */
export function parseSourcePersons(value: unknown): Person[] {
  if (!Array.isArray(value)) throw new TypeError("persons must be a list");
  const persons = value.map((entry) => {
    const source = z
      .object({ id: name, labels: sourceLabelsSchema.optional(), spec: z.unknown() })
      .strict()
      .parse(entry);
    return {
      apiVersion: "v1",
      type: "Person",
      name: source.id,
      ...(source.labels !== undefined ? { labels: source.labels } : {}),
      spec: source.spec,
    };
  });
  if (
    new Set(persons.map((person) => person.name)).size !== persons.length ||
    !validateResources(persons).valid
  )
    throw new TypeError("Invalid or duplicate Person resource");
  return persons as Person[];
}
