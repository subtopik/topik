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

  test("accepts valid Guide resources", () => {
    const result = validateResources([
      {
        apiVersion: "v1",
        type: "Guide",
        name: "getting-started",
        spec: {
          title: "Getting Started",
          slug: "getting-started",
          content: { format: "topik", value: "# Getting Started" },
        },
      },
    ]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects unsupported resource types explicitly", () => {
    const result = validateResources([
      {
        apiVersion: "v1",
        type: "Unknown",
        name: "something",
        spec: { title: "Something" },
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      resource: "Unknown/something",
      path: "/type",
      message: "Unsupported resource type: Unknown",
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
