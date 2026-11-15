import { describe, expect, test } from "vite-plus/test";
import { validateResourceContent, validateResourceGraph, validateResources } from "./validate";

const digest = "0".repeat(64);

const supportedResources = [
  {
    apiVersion: "v1",
    type: "Asset",
    name: `auto-v1-${"a".repeat(52)}`,
    spec: {
      uri: `blobs/${digest}`,
      integrity: `sha256:${digest}`,
      size: 7,
      mediaType: "image/png",
    },
  },
  {
    apiVersion: "v1",
    type: "Course",
    name: "course",
    spec: { title: "Course", slug: "course" },
  },
  {
    apiVersion: "v1",
    type: "CourseModule",
    name: "module",
    spec: { course: "course", title: "Module", slug: "module", order: 0 },
  },
  {
    apiVersion: "v1",
    type: "CoursePage",
    name: "lesson",
    spec: {
      module: "module",
      title: "Lesson",
      slug: "lesson",
      order: 0,
      content: { format: "topik", value: "# Lesson" },
    },
  },
  {
    apiVersion: "v1",
    type: "Guide",
    name: "guide",
    spec: {
      title: "Guide",
      slug: "guide",
      content: { format: "topik", value: "# Guide" },
    },
  },
  {
    apiVersion: "v1",
    type: "Person",
    name: "ada",
    spec: { name: "Ada Lovelace" },
  },
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
] as const;

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

  test("accepts every supported v1 resource through the shared runtime boundary", () => {
    expect(validateResources(supportedResources)).toEqual({ valid: true, errors: [] });
  });

  test.each(supportedResources.filter((resource) => resource.type !== "Asset"))(
    "rejects an unsupported $type version with a typed resource diagnostic",
    (resource) => {
      expect(validateResources([{ ...resource, apiVersion: "v2" }])).toEqual({
        valid: false,
        errors: [
          {
            id: "resource-unsupported-version",
            resource: `${resource.type}/${resource.name}`,
            path: "/apiVersion",
            message: `Unsupported ${resource.type} apiVersion: v2`,
          },
        ],
      });
    },
  );

  test("preserves the typed Asset version diagnostic through shared validation", () => {
    const asset = supportedResources[0];
    expect(validateResources([{ ...asset, apiVersion: "v2" }])).toEqual({
      valid: false,
      errors: [
        {
          id: "TOPIK_ASSET_UNSUPPORTED_VERSION",
          resource: `Asset/${asset.name}`,
          path: "/apiVersion",
          message: "Unsupported Asset apiVersion",
        },
      ],
    });
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
      id: "resource-unsupported-type",
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
        errors: [
          {
            id: "resource-unsupported-type",
            path: "/type",
            message: `Unsupported resource type: ${type}`,
          },
        ],
      });
    },
  );

  test("rejects non-object resources", () => {
    const result = validateResources([null, "broken"]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        id: "resource-invalid",
        resource: "unknown/unknown",
        path: "/",
        message: "Resource must be an object",
      },
      {
        id: "resource-invalid",
        resource: "unknown/unknown",
        path: "/",
        message: "Resource must be an object",
      },
    ]);
  });

  test("reports every schema violation in a resource with a typed id", () => {
    const result = validateResources([
      { apiVersion: "v1", type: "Wiki", spec: { title: 1 } },
      { type: "Wiki", name: "docs" },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        id: "resource-invalid",
        resource: "Wiki/unknown",
        path: "/",
        message: "must have required property 'name'",
      },
      {
        id: "resource-invalid",
        resource: "Wiki/unknown",
        path: "/spec/title",
        message: "must be string",
      },
      {
        id: "resource-invalid",
        resource: "Wiki/docs",
        path: "/apiVersion",
        message: "Resource apiVersion must be a string",
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

const graphResources = [
  { apiVersion: "v1", type: "Person", name: "ada", spec: { name: "Ada" } },
  {
    apiVersion: "v1",
    type: "Course",
    name: "course",
    spec: { title: "Course", slug: "course", authors: ["ada"] },
  },
  {
    apiVersion: "v1",
    type: "CourseModule",
    name: "module",
    spec: { course: "course", title: "Module", slug: "module", order: 0 },
  },
  {
    apiVersion: "v1",
    type: "CoursePage",
    name: "lesson",
    spec: {
      module: "module",
      title: "Lesson",
      slug: "lesson",
      order: 0,
      authors: ["ada"],
      content: { format: "topik", value: "# Lesson" },
    },
  },
  {
    apiVersion: "v1",
    type: "Guide",
    name: "guide",
    spec: {
      title: "Guide",
      slug: "guide",
      authors: ["ada"],
      content: { format: "topik", value: "# Guide" },
    },
  },
  {
    apiVersion: "v1",
    type: "Wiki",
    name: "docs",
    spec: {
      title: "Docs",
      navigation: [
        { type: "page", page: "docs-intro", slug: "" },
        {
          type: "group",
          title: "More",
          children: [{ type: "link", title: "Site", href: "https://example.com" }],
        },
      ],
    },
  },
  {
    apiVersion: "v1",
    type: "WikiPage",
    name: "docs-intro",
    spec: { wiki: "docs", title: "Intro", content: { format: "topik", value: "# Intro" } },
  },
] as const;

describe("validateResourceGraph", () => {
  test("accepts a complete set of resources", () => {
    expect(validateResources(graphResources)).toEqual({ valid: true, errors: [] });
    expect(validateResourceGraph(graphResources)).toEqual({ valid: true, errors: [] });
  });

  test("reports each repeated type and name after the first", () => {
    const person = graphResources[0];
    const result = validateResourceGraph([
      person,
      { ...person, type: "Guide" },
      person,
      { ...person, spec: { name: "Other" } },
    ]);
    const duplicate = {
      id: "resource-duplicate",
      resource: "Person/ada",
      path: "/name",
      message: "must be unique: another resource has the same type and name",
    };
    expect(result).toEqual({
      valid: false,
      errors: [
        { ...duplicate, index: 2 },
        { ...duplicate, index: 3 },
      ],
    });
  });

  test("reports dangling references with JSON pointers", () => {
    // The Person, Course, Wiki and WikiPage that the others reference are left out.
    const result = validateResourceGraph([
      { ...graphResources[3], spec: { ...graphResources[3].spec, module: "missing" } },
      graphResources[4],
      {
        ...graphResources[5],
        spec: {
          title: "Docs",
          navigation: [
            {
              type: "tab",
              title: "Guides",
              children: [
                {
                  type: "group",
                  title: "Start",
                  children: [{ type: "page", page: "gone", slug: "" }],
                },
              ],
            },
          ],
        },
      },
      { ...graphResources[6], spec: { ...graphResources[6].spec, wiki: "other" } },
      graphResources[2],
    ]);

    expect(result.valid).toBe(false);
    expect(
      result.errors.map(({ index, resource, path, id }) => ({ index, resource, path, id })),
    ).toEqual([
      { index: 0, resource: "CoursePage/lesson", path: "/spec/module", id: "reference-unresolved" },
      {
        index: 0,
        resource: "CoursePage/lesson",
        path: "/spec/authors/0",
        id: "reference-unresolved",
      },
      { index: 1, resource: "Guide/guide", path: "/spec/authors/0", id: "reference-unresolved" },
      {
        index: 2,
        resource: "Wiki/docs",
        path: "/spec/navigation/0/children/0/children/0/page",
        id: "reference-unresolved",
      },
      {
        index: 3,
        resource: "WikiPage/docs-intro",
        path: "/spec/wiki",
        id: "reference-unresolved",
      },
      {
        index: 4,
        resource: "CourseModule/module",
        path: "/spec/course",
        id: "reference-unresolved",
      },
    ]);
    expect(result.errors[0]?.message).toBe(
      "must reference a CourseModule in the resource set; CourseModule/missing is missing",
    );
  });

  test("does not repeat names that are not resource names and skips malformed resources", () => {
    const result = validateResourceGraph([
      null,
      "text",
      { type: "Guide" },
      { type: "CourseModule", name: "m", spec: { course: "Bad Name\n" } },
      { type: "CoursePage", name: "p", spec: { module: 7, authors: "ada" } },
    ]);
    expect(result.errors).toEqual([
      {
        id: "reference-unresolved",
        index: 3,
        resource: "CourseModule/m",
        path: "/spec/course",
        message: "must reference a Course in the resource set; the Course is missing",
      },
    ]);
  });
});

describe("validateResourceContent", () => {
  test("accepts valid topik content and compiled Asset references", () => {
    expect(validateResourceContent(graphResources)).toEqual({ valid: true, errors: [] });
    expect(
      validateResourceContent([
        {
          ...graphResources[6],
          spec: {
            ...graphResources[6].spec,
            content: { format: "topik", value: `![Logo](asset:auto-v1-${"a".repeat(52)})\n` },
          },
        },
      ]),
    ).toEqual({ valid: true, errors: [] });
  });

  test("reports content errors at the content pointer with their line", () => {
    const result = validateResourceContent([
      {
        ...graphResources[4],
        spec: {
          ...graphResources[4].spec,
          content: { format: "topik", value: "# Guide\n\n<div>raw</div>\n" },
        },
      },
      // Other formats are not Topik content.
      {
        ...graphResources[6],
        spec: { ...graphResources[6].spec, content: { format: "other", value: "<div>" } },
      },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) {
      expect(error).toMatchObject({
        id: "content-invalid",
        resource: "Guide/guide",
        path: "/spec/content/value",
      });
    }
    expect(result.errors[0]?.message).toMatch(/^line 3: /u);
  });
});
