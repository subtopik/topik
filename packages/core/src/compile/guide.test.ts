import { createProjectAssetNameGenerator } from "./asset-names";
import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Guide } from "@topik/schema/guide/v1";
import type { Person } from "@topik/schema/person/v1";
import guideV1Schema from "@topik/schema/guide/v1.json" with { type: "json" };
import { compileGuides } from "./guide";

const ajv = new Ajv2020({ strict: true, discriminator: true });
addFormats(ajv);
const validateGuide = ajv.compile(guideV1Schema);
const person = (name: string): Person => ({
  apiVersion: "v1",
  type: "Person",
  name,
  spec: { name },
});

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

  test("leaves out AGENTS.md, which is not a guide", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("hello-world", "# Hello World\n\nWelcome!");
    await writeFile(join(dir, "AGENTS.md"), "<!--TOPIK START-->\n# Agents\n<!--TOPIK END-->\n");

    const result = await compileGuides({ dir });

    expect(result.diagnostics).toEqual([]);
    expect(result.resources.map((resource) => resource.name)).toEqual(["blog-hello-world"]);
  });

  test("leaves out AGENTS.md even when its frontmatter names a guide", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("hello-world", "# Hello World\n\nWelcome!");
    await writeFile(
      join(dir, "AGENTS.md"),
      "---\nid: blog-agents\nslug: agents\n---\n# Agents\n\nHow agents work.\n",
    );

    const result = await compileGuides({ dir });

    expect(result.diagnostics).toEqual([]);
    expect(result.resources.map((resource) => resource.name)).toEqual(["blog-hello-world"]);
  });

  test("leaves out Markdown named in capitals, but not a lowercase or mixed-case name", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("2024", "# Year\n");
    await writeFile(join(dir, "CHANGELOG.md"), "<b>not Topik</b>\n");
    await writeFile(join(dir, "CODE_OF_CONDUCT.md"), "<b>not Topik</b>\n");

    const result = await compileGuides({ dir });
    expect(result.resources.map((resource) => resource.name)).toEqual(["blog-2024"]);

    await writeFile(join(dir, "Changelog.md"), "# Changelog\n");
    await expect(compileGuides({ dir })).rejects.toMatchObject({ id: "guide-name-invalid" });
  });

  test("notes a capital-named file that is not a usual repository file", async () => {
    await writeCollectionConfig('id: blog\ntitle: Blog\ninclude: ["**/*.md"]\n');
    await writeGuide("top", "# Top\n");
    await mkdir(join(dir, "basics"));
    for (const name of ["FAQ.md", "basics/API.md", "CHANGELOG.md", "AGENTS.md", "README.md"])
      await writeFile(join(dir, name), "<b>not read</b>\n");

    const result = await compileGuides({ dir });

    expect(result.resources.map((resource) => resource.name)).toEqual(["blog-top"]);
    expect(result.diagnostics).toEqual(
      ["FAQ.md", "basics/API.md"].map((file) => ({
        id: "guide-left-out",
        type: "Guide",
        level: "warning",
        message: expect.stringContaining("named in capitals"),
        lines: [],
        file,
      })),
    );

    await writeCollectionConfig(
      'id: blog\ntitle: Blog\ninclude: ["**/*.md"]\nexclude: ["FAQ.md", "basics/API.md"]\n',
    );
    expect((await compileGuides({ dir })).diagnostics).toEqual([]);

    // Without a folder pattern, a file in a folder is not selected, so it is not noted.
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    expect((await compileGuides({ dir })).diagnostics.map(({ file }) => file)).toEqual(["FAQ.md"]);
  });

  test("reads only the configuration directory unless include names a folder", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("top", "# Top\n");
    await mkdir(join(dir, "basics"), { recursive: true });
    await writeFile(join(dir, "basics", "setup.md"), "# Setup\n");

    const result = await compileGuides({ dir });
    expect(result.resources.map((resource) => resource.name)).toEqual(["blog-top"]);
  });

  test("include and exclude select guides in folders; the slug is the filename", async () => {
    await writeCollectionConfig(
      'id: blog\ntitle: Blog\ninclude: ["**/*.md"]\nexclude: ["drafts/**", "basics/skip-*.md"]\n',
    );
    await writeGuide("top", "# Top\n\n[Setup](./basics/setup.md)\n");
    for (const folder of ["basics", "basics/deep", "drafts", "node_modules/pkg", ".topik"])
      await mkdir(join(dir, folder), { recursive: true });
    await writeFile(join(dir, "basics", "setup.md"), "# Setup\n\n[Top](../top.md)\n");
    await writeFile(join(dir, "basics", "skip-me.md"), "<b>skipped</b>\n");
    await writeFile(join(dir, "basics", "deep", "more.md"), "# More\n");
    await writeFile(join(dir, "drafts", "idea.md"), "<b>draft</b>\n");
    await writeFile(join(dir, "node_modules", "pkg", "readme.md"), "<b>dependency</b>\n");
    await writeFile(join(dir, ".topik", "stale.md"), "<b>output</b>\n");
    await writeFile(join(dir, "basics", "notes.mdx"), "<b>not included</b>\n");

    const result = await compileGuides({ dir });

    expect(result.diagnostics).toEqual([]);
    expect(result.resources.map((resource) => resource.name).sort()).toEqual([
      "blog-more",
      "blog-setup",
      "blog-top",
    ]);
    expect(result.references.map((entry) => entry.reference.name).sort()).toEqual([
      "blog-setup",
      "blog-top",
    ]);
  });

  test("two files with one name in different folders are a duplicate", async () => {
    await writeCollectionConfig('id: blog\ntitle: Blog\ninclude: ["*/*.md"]\n');
    for (const folder of ["advanced", "basics"]) {
      await mkdir(join(dir, folder), { recursive: true });
      await writeFile(join(dir, folder, "setup.md"), "# Setup\n");
    }

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "guide-duplicate",
      location: "basics/setup.md",
      relatedLocation: "advanced/setup.md",
    });
  });

  test("a folder's landing page takes the folder's name", async () => {
    await writeCollectionConfig('id: blog\ntitle: Blog\ninclude: ["**/*.md", "**/*.mdx"]\n');
    await writeGuide("index", "# Home\n\n[Basics](./basics/)\n");
    for (const folder of ["advanced", "basics"]) await mkdir(join(dir, folder));
    await writeFile(join(dir, "basics", "index.md"), "# Basics\n");
    await writeFile(join(dir, "advanced", "Readme.mdx"), "# Advanced\n");

    const result = await compileGuides({ dir });

    expect(result.diagnostics).toEqual([]);
    expect(
      result.resources
        .map((resource) => `${resource.name} ${(resource as Guide).spec.slug}`)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["blog-advanced advanced", "blog-basics basics", "blog-index index"]);
    expect(result.references.map((entry) => entry.reference.name)).toEqual(["blog-basics"]);

    await writeGuide("basics", "# Also basics\n");
    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "guide-duplicate",
      location: "basics/index.md",
      relatedLocation: "basics.md",
    });
  });

  test("README.md is a guide only when its frontmatter sets id and slug", async () => {
    await writeCollectionConfig('id: blog\ntitle: Blog\ninclude: ["**/*.md"]\n');
    await writeGuide("top", "# Top\n");
    await mkdir(join(dir, "basics"));
    await writeFile(join(dir, "README.md"), "<p align=center>Repository readme</p>\n");

    const plain = await compileGuides({ dir });
    expect(plain.diagnostics).toEqual([]);
    expect(plain.resources.map((resource) => resource.name)).toEqual(["blog-top"]);

    await writeFile(join(dir, "README.md"), "---\nid: only-an-id\n---\n# Readme\n");
    expect((await compileGuides({ dir })).resources.map((resource) => resource.name)).toEqual([
      "blog-top",
    ]);

    await writeFile(join(dir, "README.md"), "---\nid: blog-home\nslug: home\n---\n# Home\n");
    const declared = await compileGuides({ dir });
    expect(declared.resources.map((resource) => resource.name).sort()).toEqual([
      "blog-home",
      "blog-top",
    ]);
  });

  test("README.md in a folder is that folder's landing page", async () => {
    await writeCollectionConfig('id: blog\ntitle: Blog\ninclude: ["**"]\n');
    await writeGuide("top", "# Top\n\n[Basics](./basics/)\n");
    await mkdir(join(dir, "basics"));
    await writeFile(join(dir, "basics", "README.md"), "# Basics\n");
    await writeFile(join(dir, "basics", "CHANGELOG.md"), "<b>not Topik</b>\n");

    const result = await compileGuides({ dir });

    expect(result.diagnostics).toEqual([]);
    expect(result.resources.map((resource) => resource.name).sort()).toEqual([
      "blog-basics",
      "blog-top",
    ]);
    expect(result.references.map((entry) => entry.reference.name)).toEqual(["blog-basics"]);
  });

  test("a README.md is a guide only when its frontmatter declares one", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("top", "# Top\n");
    await writeFile(join(dir, "README.md"), "# R\n");
    expect((await compileGuides({ dir })).resources.map((resource) => resource.name)).toEqual([
      "blog-top",
    ]);

    await writeFile(join(dir, "README.md"), "---\nid: blog-readme\nslug: readme\n---\n# R\n");
    expect((await compileGuides({ dir })).resources.map((resource) => resource.name)).toEqual([
      "blog-readme",
      "blog-top",
    ]);
  });

  test("does not follow a link to a directory", async () => {
    await writeCollectionConfig('id: blog\ntitle: Blog\ninclude: ["**/*.md"]\n');
    await writeGuide("top", "# Top\n");
    const outside = await mkdtemp(join(tmpdir(), "topik-outside-"));
    try {
      await writeFile(join(outside, "leak.md"), "# Leak\n");
      await symlink(outside, join(dir, "linked"), "dir");

      const result = await compileGuides({ dir });
      expect(result.resources.map((resource) => resource.name)).toEqual(["blog-top"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("reports only compilation-relative Guide diagnostic paths", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("unsafe", "<http://example.com/file.pdf>\n");

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ file: "unsafe.md" })],
      message: expect.not.stringContaining(dir),
    });
  });

  test("does not expose malformed external reference text in compile errors", async () => {
    const sentinel = "PRIVATE_VALUE";
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide(
      "unsafe-reference",
      `{% card title="Unsafe" href="hTtPs://user:${sentinel}@[" /%}\n`,
    );

    let failure: unknown;
    try {
      await compileGuides({ dir });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(`${String(failure)}\n${JSON.stringify(failure)}`).not.toContain(sentinel);
    expect(`${String(failure)}\n${JSON.stringify(failure)}`).not.toContain("hTtPs://user:");
  });

  test("does not turn the consumed collection config into a downloadable Asset", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("config", "[Configuration](collection.yaml)\n");
    const result = await compileGuides({
      dir,
      validation: { links: "off" },
      assets: {
        generateName: createProjectAssetNameGenerator({
          projectRoot: dir,
          projectNamespace: "protected-guide-config",
        }),
      },
    });
    expect(result.resources.filter((resource) => resource.type === "Asset")).toEqual([]);
    expect(result.payloads).toEqual([]);
  });

  test("rejects an in-root symlinked collection config before automatic Asset discovery", async () => {
    await writeFile(join(dir, "collection-source.yaml"), "id: blog\ntitle: Blog\n");
    await symlink("collection-source.yaml", join(dir, "collection.yaml"));
    await writeGuide("config", "[Configuration](collection-source.yaml)\n");

    await expect(
      compileGuides({
        dir,
        validation: { links: "off" },
        assets: {
          generateName: createProjectAssetNameGenerator({
            projectRoot: dir,
            projectNamespace: "symlinked-guide-config",
          }),
        },
      }),
    ).rejects.toMatchObject({ id: "config-read-failed", location: "collection.yaml" });
  });

  test("rejects an in-root symlinked guide source", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(join(dir, "post-source.txt"), "# Linked guide\n");
    await symlink("post-source.txt", join(dir, "post.md"));

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "guide-not-regular-file", level: "error" }),
      ]),
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

    const result = await compileGuides({
      dir,
      persons: [person("john-doe"), person("jane-smith")],
    });
    const guide = result.resources.find((resource) => resource.type === "Guide") as Guide;
    expect(guide.spec.authors).toEqual(["john-doe", "jane-smith"]);
    expect(result.resources.filter((resource) => resource.type === "Person")).toHaveLength(2);
    // Without the project's Persons, the authors resolve to nothing.
    await expect(compileGuides({ dir })).rejects.toMatchObject({ id: "author-not-found" });
  });

  test("refuses Persons declared in a collection configuration", async () => {
    await writeCollectionConfig(
      "id: blog\ntitle: Blog\npersons:\n  - { id: john-doe, spec: { name: John } }\n",
    );
    await writeFile(join(dir, "post.md"), "---\ntitle: Post\n---\n\nContent.");
    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "config-invalid",
      field: "persons",
    });
  });

  test("rejects invalid author references", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(
      join(dir, "post.md"),
      "---\ntitle: Post\nauthors:\n  - John Doe\n---\n\nContent.",
    );

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "frontmatter-invalid",
      location: "post.md",
      field: "authors[0]",
    });
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

  test("rejects markdown symlinks that resolve outside the compilation directory", async () => {
    const external = await mkdtemp(join(tmpdir(), "topik-guide-secret-"));
    try {
      await writeCollectionConfig("id: blog\ntitle: Blog\n");
      await writeFile(join(external, "secret.md"), "# Secret\n\nTOPIK_SECRET=outside-root\n");
      await symlink(join(external, "secret.md"), join(dir, "leak.md"));

      await expect(compileGuides({ dir })).rejects.toThrow(/guide-outside-compilation-root/);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  test("rejects markdown symlinks that resolve within the compilation directory", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await mkdir(join(dir, "shared"));
    await writeFile(join(dir, "shared", "post.md"), "# Shared Post\n\nReusable content.\n");
    await symlink(join(dir, "shared", "post.md"), join(dir, "alias.md"));

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "guide-not-regular-file", level: "error" }),
      ]),
    });
  });

  test("rejects markdown directories instead of reading them as guides", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await mkdir(join(dir, "directory.md"));

    await expect(compileGuides({ dir })).rejects.toThrow(/guide-not-regular-file/);
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

    await expect(compileGuides({ dir })).resolves.toMatchObject({
      diagnostics: [],
      resources: [],
      payloads: [],
    });
  });

  test("compiles local images into named Assets and shared payloads", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
      "hex",
    );
    await writeFile(join(dir, "hero.png"), png);
    await writeGuide("post", "# Post\n\n![hero](hero.png)\n");

    const result = await compileGuides({
      dir,
      assets: {
        generateName: createProjectAssetNameGenerator({
          projectRoot: dir,
          projectNamespace: "example-guides",
        }),
      },
    });
    const guide = result.resources.find((r) => r.type === "Guide") as Guide;
    const asset = result.resources.find((resource) => resource.type === "Asset");

    expect(asset?.name).toMatch(/^auto-v1-[a-z2-7]{51}[aq]$/u);
    expect(asset?.spec).toMatchObject({ mediaType: "image/png", size: png.byteLength });
    expect(result.payloads).toHaveLength(1);
    expect(guide.spec.content.value).toContain(`![hero](asset:${asset?.name})`);
    expect(guide.spec).not.toHaveProperty("assets");
  });

  test("emits no Asset resources when no assets are referenced", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("plain", "# Plain\n\nNo assets here.");

    const result = await compileGuides({ dir });
    const guide = result.resources[0] as Guide;
    expect(guide.spec).not.toHaveProperty("assets");
  });

  test("shares one automatically discovered Asset and payload across guides", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
      "hex",
    );
    await writeFile(join(dir, "shared.png"), png);
    await writeGuide("one", "# One\n\n![s](shared.png)\n");
    await writeGuide("two", "# Two\n\n![s](shared.png)\n");

    const result = await compileGuides({
      dir,
      assets: {
        generateName: createProjectAssetNameGenerator({
          projectRoot: dir,
          projectNamespace: "example-guides",
        }),
      },
    });
    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
    expect(result.payloads).toHaveLength(1);
  });

  test("rejects invalid Topik content in guides", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("post", "# Post\n\n{% tabs %}\nPlain paragraph\n{% /tabs %}\n");

    await expect(compileGuides({ dir })).rejects.toThrow(/post\.md:[\s\S]*topik-tabs-children/);
  });

  test("validates local heading fragments with configurable severity", async () => {
    await writeCollectionConfig("id: docs\ntitle: Docs\n");
    await writeGuide("post", "# Post\n\n[Missing](#missing)\n");

    await expect(compileGuides({ dir })).rejects.toThrow(/link-fragment-not-found/);

    const warning = await compileGuides({ dir, validation: { links: "warning" } });
    expect(warning.diagnostics).toEqual([
      expect.objectContaining({ id: "link-fragment-not-found", level: "warning" }),
    ]);

    const off = await compileGuides({ dir, validation: { links: "off" } });
    expect(off.diagnostics).toEqual([]);
  });

  test("does not disclose a missing local fragment through compile diagnostics", async () => {
    const sentinel = "PRIVATE_VALUE";
    await writeCollectionConfig("id: docs\ntitle: Docs\n");
    await writeGuide("post", `# Post\n\n[Missing](#${sentinel})\n`);

    const warning = await compileGuides({ dir, validation: { links: "warning" } });
    expect(warning.diagnostics).toEqual([
      expect.objectContaining({
        id: "link-fragment-not-found",
        message: "Link target heading or accordion was not found.",
      }),
    ]);
    expect(JSON.stringify(warning.diagnostics)).not.toContain(sentinel);

    await expect(compileGuides({ dir })).rejects.not.toThrow(sentinel);
  });

  test("keeps duplicate heading IDs out of useful compiler diagnostics", async () => {
    const sentinel = "PRIVATE_VALUE_SENTINEL";
    await writeCollectionConfig("id: docs\ntitle: Docs\n");
    await writeGuide("post", `## One {% #${sentinel} %}\n\n## Two {% #${sentinel} %}\n`);

    let failure: unknown;
    try {
      await compileGuides({ dir });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          file: "post.md",
          id: "heading-id-duplicate",
          message: "Explicit heading and accordion IDs must be unique within a document.",
        }),
      ],
    });
    expect(String(failure)).toContain("heading-id-duplicate");
    expect(`${String(failure)}\n${JSON.stringify(failure)}`).not.toContain(sentinel);
    expect(`${String(failure)}\n${JSON.stringify(failure)}`).not.toContain(dir);
  });

  test("compiled Guide resources validate against schema", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\ntags:\n  - official\n");
    await writeFile(
      join(dir, "getting-started.md"),
      "---\ntitle: Getting Started\ntags:\n  - beginner\nauthors:\n  - john-doe\n---\n\n# Getting Started\n\nWelcome!",
    );

    const { resources } = await compileGuides({ dir, persons: [person("john-doe")] });
    for (const resource of resources.filter((entry) => entry.type === "Guide")) {
      const valid = validateGuide(resource);
      if (!valid) {
        console.error(validateGuide.errors);
      }
      expect(valid).toBe(true);
    }
  });

  test("rejects .md and .mdx files that produce the same Guide identity", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("foo", "# Markdown\n");
    await writeFile(join(dir, "foo.mdx"), "# MDX\n");

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      name: "PublicCompileError",
      id: "guide-duplicate",
      location: "foo.mdx",
      relatedLocation: "foo.md",
    });
  });

  test("rejects Guides that declare the same frontmatter id", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("a", "---\nid: shared\n---\n# A\n");
    await writeGuide("b", "---\nid: shared\nslug: other\n---\n# B\n");

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "guide-duplicate",
      location: "b.md",
      relatedLocation: "a.md",
    });
  });

  test.each(["My Guide", "Upper", "under_score", "dotted.name", "double--hyphen"])(
    "rejects filename-derived Guide identities that are not valid names: %j",
    async (name) => {
      await writeCollectionConfig("id: blog\ntitle: Blog\n");
      await writeGuide(name, "# Guide\n");

      await expect(compileGuides({ dir })).rejects.toMatchObject({
        name: "PublicCompileError",
        id: "guide-name-invalid",
        location: `${name}.md`,
      });
    },
  );

  test("rejects filename-derived Guide names longer than a resource name allows", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("a".repeat(59), "# Guide\n");
    await writeGuide("b".repeat(58), "# Guide\n");

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "guide-name-invalid",
      location: `${"a".repeat(59)}.md`,
    });
  });

  test("accepts any filename when frontmatter supplies both id and slug", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("My Guide", "---\nid: my-guide\nslug: my-guide\n---\n# Guide\n");

    const result = await compileGuides({ dir });
    expect(result.resources).toContainEqual(
      expect.objectContaining({
        name: "my-guide",
        spec: expect.objectContaining({ slug: "my-guide" }),
      }),
    );
  });

  test("rejects invalid UTF-8 instead of substituting replacement characters", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeFile(join(dir, "broken.md"), Buffer.from([0x23, 0x20, 0xff, 0x0a]));

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "document-encoding-invalid",
      location: "broken.md",
    });
  });

  test("names a misspelled collection key and the invalid config field", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\ntag: [a]\n");
    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "config-field-unknown",
      location: "collection.yaml",
      field: "tag",
    });

    await writeCollectionConfig("id: blog\ntitle: Blog\ntags: [a, 7]\n");
    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "config-invalid",
      location: "collection.yaml",
      field: "tags[1]",
    });
  });

  test.each([
    ["description", `---\ndescription: ${"x".repeat(5000)}\n---\n# Post\n`],
    ["title", `---\ntitle: ${"x".repeat(5000)}\n---\n# Post\n`],
    ["title", `# ${"x".repeat(5000)}\n`],
  ])("refuses a schema-invalid %s at the Guide file", async (field, source) => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("post", source);

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "frontmatter-invalid",
      location: "post.md",
      field,
    });
  });

  test("names the invalid frontmatter field", async () => {
    await writeCollectionConfig("id: blog\ntitle: Blog\n");
    await writeGuide("post", "---\nslug: Not A Slug\n---\n# Post\n");

    await expect(compileGuides({ dir })).rejects.toMatchObject({
      id: "frontmatter-invalid",
      location: "post.md",
      field: "slug",
    });
  });
});
