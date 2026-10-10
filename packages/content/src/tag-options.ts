import type { TagSyntaxOptions } from "@topik/remark-tags";
import type { Registry } from "./registry.js";

/** Parser and writer share the exact registry attribute admission. */
export function tagOptions(registry: Registry): TagSyntaxOptions {
  return {
    expressions: true,
    escapedWhitespace: Object.fromEntries(
      Object.entries(registry).map(([name, definition]) => [
        name,
        Object.entries(definition.attributes)
          .filter(([, attribute]) => attribute.type === "string" && attribute.escapedWhitespace)
          .map(([key]) => key),
      ]),
    ),
  };
}
