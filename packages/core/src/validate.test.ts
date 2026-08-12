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

  test.each(["constructor", "toString", "__proto__"])(
    "rejects prototype-named resource type %s without throwing",
    (type) => {
      expect(() => validateResources([{ type }])).not.toThrow();
      expect(validateResources([{ type }])).toMatchObject({
        valid: false,
        errors: [{ path: "/type", message: `Unsupported resource type: ${type}` }],
      });
    },
  );

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

  test("does not allow inherited members to satisfy resource schemas", () => {
    const valid = {
      apiVersion: "v1",
      type: "Guide",
      name: "guide",
      spec: {
        title: "Guide",
        slug: "guide",
        content: { format: "topik", value: "# Guide\n" },
      },
    };
    expect(validateResources([Object.create(valid)])).toMatchObject({ valid: false });
    expect(validateResources([{ ...valid, spec: Object.create(valid.spec) }])).toMatchObject({
      valid: false,
    });
  });

  test("preserves the typed diagnostic for contradictory Asset payload digests", () => {
    const digest = "0".repeat(64);
    const result = validateResources([
      {
        apiVersion: "v1",
        type: "Asset",
        name: `auto-v1-${"a".repeat(52)}`,
        spec: {
          uri: `blobs/${digest}`,
          integrity: `sha256:${"f".repeat(64)}`,
          size: 7,
          mediaType: "image/png",
        },
      },
    ]);

    expect(result).toEqual({
      valid: false,
      errors: [
        {
          id: "TOPIK_ASSET_DIGEST_MISMATCH",
          resource: `Asset/auto-v1-${"a".repeat(52)}`,
          path: "/spec/integrity",
          message: "Asset payload URI and integrity must identify the same digest",
        },
      ],
    });
  });
});
