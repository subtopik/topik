import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { listManifestDocuments } from "./manifest";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "topik-documents-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

const manifest = (sources: [kind: string, config: string][]) =>
  `version: 1\nnamespace: example/docs\nsources:\n${sources
    .map(([kind, config]) => `  - kind: ${kind}\n    config: ${config}\n`)
    .join("")}`;

test("lists the files every kind of source reads, valid or not, and nothing else", async () => {
  await write({
    ".topik.yaml": manifest([
      ["wiki", "docs/wiki.yaml"],
      ["collection", "guides/collection.yaml"],
      ["course", "course/course.yaml"],
    ]),
    "README.md": "<p>Repository readme</p>\n",
    "notes.md": "# Not project content\n",
    "docs/wiki.yaml": "id: docs\ntitle: Docs\nnavigation: [index, guides/setup, missing]\n",
    "docs/index.md": "# Home\n",
    "docs/guides/setup.mdx": "<b>invalid content is still listed</b>\n",
    "docs/unlisted.md": "# Not in navigation\n",
    "guides/collection.yaml":
      'id: blog\ntitle: Blog\ninclude: ["**/*.md"]\nexclude: ["drafts/**"]\n',
    "guides/hello.md": "# Hello\n",
    "guides/basics/index.md": "# Basics\n",
    "guides/basics/README.md": "# Landing\n",
    "guides/drafts/idea.md": "# Idea\n",
    "guides/README.md": "<p>Not a guide</p>\n",
    "guides/FAQ.md": "# Left out\n",
    "course/course.yaml": JSON.stringify({
      sourceVersion: 1,
      id: "learning",
      title: "Learning",
      slug: "learning",
      modules: [{ id: "basics", title: "Basics", slug: "basics", order: 0, pages: ["one", "two"] }],
    }),
    "course/one.md": "---\nnot: valid frontmatter for a course page\n---\n# One\n",
    "course/two.mdx": "# Two\n",
    "course/three.md": "# Not declared\n",
  });

  expect(await listManifestDocuments({ dir })).toEqual([
    "course/one.md",
    "course/two.mdx",
    "docs/guides/setup.mdx",
    "docs/index.md",
    "guides/basics/README.md",
    "guides/basics/index.md",
    "guides/hello.md",
  ]);
});

test("lists a file two sources read once, and both spellings of an ambiguous page", async () => {
  await write({
    ".topik.yaml": manifest([
      ["wiki", "wiki.yaml"],
      ["collection", "collection.yaml"],
    ]),
    "wiki.yaml": "id: docs\ntitle: Docs\nnavigation: [index, both]\n",
    "collection.yaml": "id: blog\ntitle: Blog\n",
    "index.md": "# Home\n",
    "both.md": "# Both\n",
    "both.mdx": "# Both\n",
  });

  expect(await listManifestDocuments({ dir })).toEqual(["both.md", "both.mdx", "index.md"]);
});

test("leaves out a declared page that is a symbolic link", async () => {
  await write({
    ".topik.yaml": manifest([["wiki", "wiki.yaml"]]),
    "wiki.yaml": "id: docs\ntitle: Docs\nnavigation: [index, linked]\n",
    "index.md": "# Home\n",
  });
  await symlink(join(dir, "index.md"), join(dir, "linked.md"));

  expect(await listManifestDocuments({ dir })).toEqual(["index.md"]);
});

test("a README beside a versioned collection is listed only when it names a guide", async () => {
  await write({
    ".topik.yaml": manifest([["collection", "collection.yaml"]]),
    "collection.yaml": "sourceVersion: 1\nid: blog\ntitle: Blog\n",
    "hello.md": "# Hello\n",
    "README.md": "# Readme\n",
  });
  expect(await listManifestDocuments({ dir })).toEqual(["hello.md"]);

  await write({ "README.md": "---\nid: blog-home\nslug: home\n---\n# Home\n" });
  expect(await listManifestDocuments({ dir })).toEqual(["README.md", "hello.md"]);
});

test("fails as compilation does on a missing manifest or an invalid configuration", async () => {
  await expect(listManifestDocuments({ dir })).rejects.toMatchObject({ id: "manifest-required" });

  await write({
    ".topik.yaml": manifest([["collection", "guides/collection.yaml"]]),
    "guides/collection.yaml": "id: Not Valid\ntitle: Blog\n",
  });
  await expect(listManifestDocuments({ dir })).rejects.toMatchObject({
    id: "config-invalid",
    kind: "collection",
  });
});
