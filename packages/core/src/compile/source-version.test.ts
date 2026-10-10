import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { compileManifest } from "./manifest";
import { compileGuides } from "./guide";
import { resolveWikiContentHref, resolveWikiNavigation } from "../wiki-navigation";
import type { Wiki } from "@topik/schema/wiki/v1";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "topik-source-version-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function file(path: string, value: string) {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), value);
}
async function manifest(kind: "wiki" | "collection", config: string) {
  await file(
    ".topik.yaml",
    `version: 1\nnamespace: examples/writeback\nsources:\n  - kind: ${kind}\n    config: ${config}\n`,
  );
}

test("versioned Guide metadata preserves identity, explicit empty tags/authors, null description and full Person facts", async () => {
  await manifest("collection", "blog/posts.yml");
  await file(
    "blog/posts.yml",
    "id: blog\ntitle: Blog\nsourceVersion: 1\ntags: [inherited]\npersons:\n  - id: ada\n    labels: { role: author }\n    spec: { name: Ada, email: null, bio: '' }\n",
  );
  await file(
    "blog/original.md",
    "---\r\nid: portable-guide\r\nslug: public-route\r\ntitle: Original\r\ndescription: null\r\nauthors: []\r\ntags: []\r\ninheritTags: false\r\nlabels: {}\r\n---\r\n# Original\r\n",
  );
  const result = await compileManifest({ dir });
  expect(result.resources.find((r) => r.type === "Guide")).toEqual({
    apiVersion: "v1",
    type: "Guide",
    name: "portable-guide",
    labels: {},
    spec: {
      title: "Original",
      slug: "public-route",
      description: null,
      authors: [],
      tags: [],
      content: { format: "topik", value: "# Original\r\n" },
    },
  });
  expect(result.resources.find((r) => r.type === "Person")).toEqual({
    apiVersion: "v1",
    type: "Person",
    name: "ada",
    labels: { role: "author" },
    spec: { name: "Ada", email: null, bio: "" },
  });
});

test("unversioned frontmatter IDs and routes remain opaque", async () => {
  await manifest("collection", "collection.yaml");
  await file("collection.yaml", "id: blog\ntitle: Blog\n");
  await file(
    "post.md",
    "---\nid: opaque-author-value\nslug: opaque-route\nlabels: { custom: value }\n---\n# Post\n",
  );
  const result = await compileManifest({ dir });
  expect(result.resources[0]).toMatchObject({ name: "blog-post", spec: { slug: "post" } });
  expect(result.resources[0]).not.toHaveProperty("labels");
});

test("versioned Wiki routes and relative source links share one resolver inside the local config root", async () => {
  await manifest("wiki", "docs/custom.json");
  await file(
    "docs/custom.json",
    JSON.stringify({
      id: "docs",
      title: "Docs",
      sourceVersion: 1,
      description: null,
      labels: {},
      navigation: [
        { type: "page", slug: "intro", source: "pages/start", hidden: true },
        { type: "page", slug: "reference", source: "pages/next" },
      ],
    }),
  );
  await file(
    "docs/pages/start.md",
    "---\nid: intro-page\ndescription: null\nlabels: {}\n---\n# Start\n\n[Next](next.md?view=a%20b&view=c#next)\n[Root source](/pages/next.md#next)\n[Route](/reference#next)\n",
  );
  await file("docs/pages/next.md", "---\nid: next-page\n---\n# Next\n");
  const result = await compileManifest({ dir });
  const wiki = result.resources.find((r) => r.type === "Wiki") as Wiki;
  expect(wiki).toMatchObject({
    labels: {},
    spec: {
      sourceVersion: 1,
      description: null,
      navigation: [
        { page: "intro-page", sourcePath: "pages/start", slug: "intro", hidden: true },
        { page: "next-page", sourcePath: "pages/next", slug: "reference" },
      ],
    },
  });
  expect(result.provenance[0].sourcePathsByResource["WikiPage/intro-page"]).toBe(
    "docs/pages/start.md",
  );
  const resolved = resolveWikiNavigation(wiki.spec.navigation!, {
    sourceVersion: wiki.spec.sourceVersion,
  });
  expect(
    resolveWikiContentHref("next.md?view=a%20b&view=c#next", "intro-page", resolved),
  ).toMatchObject({
    page: { page: "next-page" },
    route: "reference",
    search: "?view=a%20b&view=c",
    hash: "next",
  });
  expect(resolveWikiContentHref("/pages/next.md#next", "intro-page", resolved)?.page.page).toBe(
    "next-page",
  );
  expect(resolveWikiContentHref("/reference", "intro-page", resolved)?.page.page).toBe("next-page");
  expect(resolveWikiContentHref("/pages/next", "intro-page", resolved)).toBeNull();
  expect(resolveWikiContentHref("/pages/next%2Emd#next", "intro-page", resolved)?.page.page).toBe(
    "next-page",
  );
  expect(resolveWikiContentHref("reference.md", "intro-page", resolved)).toBeNull();
});

test("versioned Wiki source ambiguity is rejected instead of selecting an extension", async () => {
  await manifest("wiki", "wiki.yaml");
  await file("wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [intro]\n");
  await file("intro.md", "# One\n");
  await file("intro.mdx", "# Two\n");
  await expect(compileManifest({ dir })).rejects.toMatchObject({ id: "wiki-page-ambiguous" });
});

test("versioned metadata refuses invalid types and oversized fields without truncation", async () => {
  await manifest("wiki", "wiki.yaml");
  await file("wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [intro]\n");
  await file("intro.md", `---\ndescription: ${"x".repeat(1025)}\n---\n# Intro\n`);
  await expect(compileManifest({ dir })).rejects.toBeDefined();
});

test("versioned author references are checked against the whole declared project", async () => {
  await manifest("collection", "collection.yaml");
  await file("collection.yaml", "id: blog\ntitle: Blog\nsourceVersion: 1\n");
  await file("post.md", "---\nauthors: [missing]\n---\n# Post\n");
  await expect(compileManifest({ dir })).rejects.toMatchObject({ id: "author-not-found" });
  await expect(compileGuides({ dir })).rejects.toMatchObject({ id: "author-not-found" });
});

test("unversioned Wiki labels remain opaque while versioned labels require the public shape", async () => {
  await manifest("wiki", "wiki.yaml");
  await file("wiki.yaml", "id: docs\ntitle: Docs\nlabels: [opaque]\n");
  expect((await compileManifest({ dir })).resources[0]).not.toHaveProperty("labels");
  await file("wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nlabels: [opaque]\n");
  await expect(compileManifest({ dir })).rejects.toMatchObject({ id: "config-invalid" });
});
