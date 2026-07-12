import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { resolveWikiNavigation, type Wiki } from "@topik/schema";
import { validateResources } from "../validate";
import { compileWiki } from "./wiki";

const docsDir = join(import.meta.dirname, "../../../../docs");

describe("Topik documentation wiki", () => {
  test("compiles as a self-hosted conformance wiki", async () => {
    const { resources } = await compileWiki({ dir: docsDir });
    const wiki = resources.find((resource): resource is Wiki => resource.type === "Wiki");
    const pages = resources.filter((resource) => resource.type === "WikiPage");

    expect(wiki?.name).toBe("topik-docs");
    expect(pages).toHaveLength(4);
    expect(validateResources(resources)).toEqual({ valid: true, errors: [] });
    const resolved = resolveWikiNavigation(wiki?.spec.navigation ?? []);
    expect(resolved.pages.map((page) => page.route)).toEqual([
      "",
      "resources",
      "navigation",
      "rendering",
    ]);
  });
});
