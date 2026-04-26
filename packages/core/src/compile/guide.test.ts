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
    expect((result.resources[0] as Guide).spec.title).toBe("My Custom Title");
  });

  test("uses frontmatter title over heading", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(
      join(dir, "post.md"),
      "---\ntitle: Frontmatter Title\n---\n\n# Heading Title\n",
    );

    const result = await compileGuides({ dir });
    expect((result.resources[0] as Guide).spec.title).toBe("Frontmatter Title");
  });

  test("falls back to formatted filename when no heading", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("getting-started", "No heading here, just content.");

    const result = await compileGuides({ dir });
    expect((result.resources[0] as Guide).spec.title).toBe("Getting Started");
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

  test("rejects invalid author references", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(
      join(dir, "post.md"),
      "---\ntitle: Post\nauthors:\n  - John Doe\n---\n\nContent.",
    );

    await expect(compileGuides({ dir })).rejects.toThrow(
      "authors[0] in post.md must be a DNS-1123 resource name",
    );
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
    const guide = result.resources[0] as Guide;
    expect(guide.name).toBe("blog-intro");
    expect(guide.spec.title).toBe("Introduction");
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

  test("returns no resources when the collection config is missing", async () => {
    await writeGuide("post", "# Post\n");

    await expect(compileGuides({ dir })).resolves.toEqual({ resources: [] });
  });

  test("extracts local image references as Asset resources", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
      "hex",
    );
    await writeFile(join(dir, "hero.png"), png);
    await writeGuide("post", "# Post\n\n![hero](./hero.png)\n");

    const result = await compileGuides({ dir });
    const guide = result.resources.find((r) => r.type === "Guide") as Guide;
    const assets = result.resources.filter((r) => r.type === "Asset");

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      type: "Asset",
      spec: { uri: "hero.png", mediaType: "image/png" },
    });
    expect(assets[0].name).toMatch(/^[a-f0-9]{16}$/);
    expect(guide.spec.content.value).toContain(`![hero](asset:${assets[0].name})`);
  });

  test("dedupes assets referenced from multiple guides", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
      "hex",
    );
    await writeFile(join(dir, "shared.png"), png);
    await writeGuide("one", "# One\n\n![s](./shared.png)\n");
    await writeGuide("two", "# Two\n\n![s](./shared.png)\n");

    const result = await compileGuides({ dir });
    const assets = result.resources.filter((r) => r.type === "Asset");
    expect(assets).toHaveLength(1);
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
