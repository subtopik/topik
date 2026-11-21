import guideV1Schema from "@topik/schema/guide/v1.json" with { type: "json" };

// Every resource schema spells names and slugs alike; the Guide schema is the reference, and a
// test keeps the others equal to it.
const nameSchema = guideV1Schema.properties.name;
const slugSchema = guideV1Schema.properties.spec.properties.slug;

/** A resource name: lowercase DNS-style segments, such as `getting-started`. */
export const RESOURCE_NAME_PATTERN = new RegExp(nameSchema.pattern, "u");
export const RESOURCE_NAME_MAX_LENGTH = nameSchema.maxLength;
/** A public slug: the same segments as a name, up to a longer length. */
export const SLUG_PATTERN = new RegExp(slugSchema.pattern, "u");
export const SLUG_MAX_LENGTH = slugSchema.maxLength;

export function isResourceName(value: string): boolean {
  return value.length <= RESOURCE_NAME_MAX_LENGTH && RESOURCE_NAME_PATTERN.test(value);
}

export function isSlug(value: string): boolean {
  return value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}
