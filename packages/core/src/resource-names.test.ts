import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { RESOURCE_NAME_MAX_LENGTH, RESOURCE_NAME_PATTERN, SLUG_PATTERN } from "./resource-names";

const schemaRoot = join(import.meta.dirname, "../../schema/src");

test("every resource schema spells names and slugs with the shared pattern", () => {
  for (const resource of readdirSync(schemaRoot, { withFileTypes: true })) {
    if (!resource.isDirectory() || resource.name === "resource") continue;
    const schema = JSON.parse(readFileSync(join(schemaRoot, resource.name, "v1.json"), "utf8"));
    expect(schema.properties.name, resource.name).toMatchObject({
      pattern: RESOURCE_NAME_PATTERN.source,
      maxLength: RESOURCE_NAME_MAX_LENGTH,
    });
    const slug = schema.properties.spec?.properties?.slug;
    if (slug) expect(slug.pattern, resource.name).toBe(SLUG_PATTERN.source);
  }
});
