import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { guideSchema, type Guide } from "@topik/schema";
import { compileGuides } from "./guide";

const ajv = new Ajv2020({ strict: true, discriminator: true });
addFormats(ajv);
const validateGuide = ajv.compile(guideSchema);

describe("compileGuides", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-guide-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeCollectionConfig(config: string) {
    await writeFile(join(dir, "collection.yaml"), config);
  }

  async function writeGuide(name: string, content: string) {
    await writeFile(join(dir, `${name}.md`), content);
  }

  test("compiles guides from markdown files in directory", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("hello-world", "# Hello World\n\nWelcome!");

    const result = await compileGuides({ dir });

    expect(result.resources).toHaveLength(1);
    const guide = result.resources[0];
    expect(guide).toMatchObject({
      apiVersion: "v1",
      type: "Guide",
      name: "blog-hello-world",
      spec: {
        title: "Hello World",
        slug: "hello-world",
        content: { format: "topik", value: "# Hello World\n\nWelcome!" },
      },
    });
  });

  test("extracts title from markdown heading", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("my-post", "# My Custom Title\n\nContent here.");

    const result = await compileGuides({ dir });
    expect(result.resources[0].spec.title).toBe("My Custom Title");
  });

  test("uses frontmatter title over heading", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(
      join(dir, "post.md"),
      "---\ntitle: Frontmatter Title\n---\n\n# Heading Title\n",
    );

    const result = await compileGuides({ dir });
    expect(result.resources[0].spec.title).toBe("Frontmatter Title");
  });

  test("falls back to formatted filename when no heading", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("getting-started", "No heading here, just content.");

    const result = await compileGuides({ dir });
    expect(result.resources[0].spec.title).toBe("Getting Started");
  });

  test("merges collection tags with frontmatter tags", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\ntags:\n  - blog\n  - official\n");
    await writeFile(
      join(dir, "post.md"),
      "---\ntitle: Post\ntags:\n  - react\n  - blog\n---\n\nContent.",
    );

    const result = await compileGuides({ dir });
    const guide = result.resources[0] as Guide;
    expect(guide.spec.tags).toEqual(["blog", "official", "react"]);
  });

  test("includes only collection tags when no frontmatter tags", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\ntags:\n  - official\n");
    await writeGuide("post", "# Post\n\nContent.");

    const result = await compileGuides({ dir });
    expect((result.resources[0] as Guide).spec.tags).toEqual(["official"]);
  });

  test("includes only frontmatter tags when no collection tags", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(join(dir, "post.md"), "---\ntags:\n  - react\n---\n\n# Post\n\nContent.");

    const result = await compileGuides({ dir });
    expect((result.resources[0] as Guide).spec.tags).toEqual(["react"]);
  });

  test("omits tags when neither collection nor frontmatter have them", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("post", "# Post\n\nContent.");

    const result = await compileGuides({ dir });
    expect(result.resources[0].spec).not.toHaveProperty("tags");
  });

  test("extracts description from frontmatter", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(
      join(dir, "post.md"),
      "---\ntitle: Post\ndescription: A short summary\n---\n\nContent.",
    );

    const result = await compileGuides({ dir });
    expect((result.resources[0] as Guide).spec.description).toBe("A short summary");
  });

  test("extracts authors from frontmatter", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(
      join(dir, "post.md"),
      "---\ntitle: Post\nauthors:\n  - john-doe\n  - jane-smith\n---\n\nContent.",
    );

    const result = await compileGuides({ dir });
    expect((result.resources[0] as Guide).spec.authors).toEqual(["john-doe", "jane-smith"]);
  });

  test("compiles multiple guides sorted by filename", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("zebra", "# Zebra\n");
    await writeGuide("alpha", "# Alpha\n");

    const result = await compileGuides({ dir });
    expect(result.resources.map((r) => r.name)).toEqual(["blog-alpha", "blog-zebra"]);
  });

  test("supports .mdx files", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(join(dir, "intro.mdx"), "---\ntitle: Introduction\n---\n\nSome MDX content.");

    const result = await compileGuides({ dir });
    expect(result.resources[0].name).toBe("blog-intro");
    expect(result.resources[0].spec.title).toBe("Introduction");
  });

  test("ignores non-markdown files", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("post", "# Post\n");
    await writeFile(join(dir, "readme.txt"), "Not a guide");

    const result = await compileGuides({ dir });
    expect(result.resources).toHaveLength(1);
  });

  test("does not include collection.yaml as a guide", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("post", "# Post\n");

    const result = await compileGuides({ dir });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].name).toBe("blog-post");
  });

  test("compiled Guide resources validate against schema", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\ntags:\n  - official\n");
    await writeFile(
      join(dir, "getting-started.md"),
      "---\ntitle: Getting Started\ntags:\n  - beginner\nauthors:\n  - john-doe\n---\n\n# Getting Started\n\nWelcome!",
    );

    const { resources } = await compileGuides({ dir });
    for (const resource of resources) {
      const valid = validateGuide(resource);
      if (!valid) {
        console.error(validateGuide.errors);
      }
      expect(valid).toBe(true);
    }
  });
});
