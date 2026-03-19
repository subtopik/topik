import { describe, expect, test } from "vite-plus/test";
import { validateResources } from "./validate";

describe("validateResources", () => {
  test("accepts supported wiki resources", () => {
    const result = validateResources([
      {
        apiVersion: "v1",
        type: "Wiki",
        name: "docs",
        spec: { title: "Docs" },
      },
      {
        apiVersion: "v1",
        type: "WikiPage",
        name: "docs-intro",
        spec: {
          wiki: "docs",
          title: "Intro",
          content: { format: "topik", value: "# Intro" },
        },
      },
    ]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects unsupported resource types explicitly", () => {
    const result = validateResources([
      {
        apiVersion: "v1",
        type: "Guide",
        name: "getting-started",
        spec: { title: "Getting Started" },
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      resource: "Guide/getting-started",
      path: "/type",
      message: "Unsupported resource type: Guide",
    });
  });

  test("rejects non-object resources", () => {
    const result = validateResources([null, "broken"]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        resource: "unknown/unknown",
        path: "/",
        message: "Resource must be an object",
      },
      {
        resource: "unknown/unknown",
        path: "/",
        message: "Resource must be an object",
      },
    ]);
  });
});
