import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { AssetCompilationError } from "./assets";
import { compile, lint } from "./index";
import { ManifestSourceError } from "./manifest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "topik-lint-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const wikiManifest =
  "version: 1\nnamespace: example/lint\nsources:\n  - kind: wiki\n    config: wiki.yaml\n";
const badCallout = '{% callout variant="bad" %}\nText\n{% /callout %}\n';

function summary(result: Awaited<ReturnType<typeof lint>>) {
  return {
    diagnostics: result.diagnostics.map(({ id, file, lines, level }) => [id, file, lines, level]),
    failures: result.failures.map((failure) => [
      (failure.error as Error).name,
      failure.documents ?? [],
    ]),
  };
}

test("reports a content error, a broken link elsewhere and their warnings together", async () => {
  const dir = await fixture({
    ".topik.yaml": wikiManifest,
    "wiki.yaml": "id: lint\ntitle: Lint\nnavigation:\n  - a\n  - b\n",
    "a.md": `# A\n\n${badCallout}`,
    "b.md": "# B\n\n## Step\n\n## Step\n\n[Second](#step-1)\n\n[Gone](./nope.md)\n",
  });

  expect(summary(await lint({ dir }))).toEqual({
    diagnostics: [
      ["attribute-value-invalid", "a.md", [3], "error"],
      ["link-fragment-positional", "b.md", [7], "warning"],
      ["link-page-not-found", "b.md", [9], "error"],
    ],
    failures: [],
  });
});

test("links to a page whose content is invalid are not reported as missing", async () => {
  const dir = await fixture({
    ".topik.yaml": wikiManifest,
    "wiki.yaml": "id: lint\ntitle: Lint\nnavigation:\n  - a\n  - b\n",
    "a.md": `# A\n\n## Setup\n\n${badCallout}`,
    "b.md": [
      "# B",
      "[By path](./a.md)",
      "[By route](/a)",
      "[By reference](ref://wiki-page/lint-a)",
      "[With a fragment](./a.md#setup)",
      "[Missing fragment](./a.md#absent)",
      "",
    ].join("\n\n"),
  });

  // Only A's own error: its anchors are checked once its content is valid.
  expect(summary(await lint({ dir }))).toEqual({
    diagnostics: [["attribute-value-invalid", "a.md", [5], "error"]],
    failures: [],
  });
});

test("a missing image is reported with the other problems and names its page", async () => {
  const dir = await fixture({
    ".topik.yaml": wikiManifest,
    "wiki.yaml": "id: lint\ntitle: Lint\nnavigation:\n  - a\n  - b\n",
    "a.md": `# A\n\n${badCallout}`,
    "b.md": "# B\n\n![Diagram](diagram.png)\n\n[Gone](./nope.md)\n",
  });

  const result = await lint({ dir });
  expect(summary(result)).toEqual({
    diagnostics: [
      ["attribute-value-invalid", "a.md", [3], "error"],
      ["link-page-not-found", "b.md", [5], "error"],
    ],
    failures: [["AssetCompilationError", ["b.md"]]],
  });
  expect((result.failures[0].error as AssetCompilationError).diagnostics[0].id).toBe(
    "TOPIK_ASSET_FILE_MISSING",
  );
});

test("a broken source is one failure, and the other sources are still checked", async () => {
  const dir = await fixture({
    ".topik.yaml":
      "version: 1\nnamespace: example/lint\nsources:\n  - kind: wiki\n    config: wiki/wiki.yaml\n  - kind: collection\n    config: guides/collection.yaml\n",
    "wiki/wiki.yaml": "id: [broken\n",
    "wiki/index.md": "# Index\n",
    "guides/collection.yaml": "id: guides\ntitle: Guides\n",
    "guides/intro.md": `# Intro\n\n[Wiki](../wiki/index.md)\n\n${badCallout}`,
    "guides/FAQ.md": "# FAQ\n",
  });

  const result = await lint({ dir });
  // No link check runs, so the link into the broken source is not reported either way.
  expect(summary(result)).toEqual({
    diagnostics: [
      ["guide-left-out", "guides/FAQ.md", [], "warning"],
      ["attribute-value-invalid", "guides/intro.md", [5], "error"],
    ],
    failures: [["ManifestSourceError", []]],
  });
  expect(result.failures[0].error).toBeInstanceOf(ManifestSourceError);
});

test("compile still stops at the first stage with an error and writes nothing", async () => {
  const dir = await fixture({
    ".topik.yaml": wikiManifest,
    "wiki.yaml": "id: lint\ntitle: Lint\nnavigation:\n  - a\n  - b\n",
    "a.md": `# A\n\n${badCallout}`,
    "b.md": "# B\n\n![Diagram](diagram.png)\n",
  });

  await expect(compile({ dir })).rejects.toMatchObject({
    name: "CompileError",
    diagnostics: [expect.objectContaining({ id: "attribute-value-invalid" })],
  });
  await writeFile(join(dir, "a.md"), "# A\n");
  await expect(compile({ dir })).rejects.toBeInstanceOf(AssetCompilationError);
  expect((await readdir(dir)).sort()).toEqual([".topik.yaml", "a.md", "b.md", "wiki.yaml"]);
  expect(await readFile(join(dir, "a.md"), "utf8")).toBe("# A\n");
});

test("Course links to a page whose content is invalid are not reported as missing", async () => {
  const page = (id: string, slug: string, order: number, body: string) =>
    `---\nid: ${id}\ntitle: ${id}\nslug: ${slug}\norder: ${order}\n---\n${body}`;
  const dir = await fixture({
    ".topik.yaml":
      "version: 1\nnamespace: example/lint\nsources:\n  - kind: course\n    config: course.yaml\n",
    "course.yaml":
      "sourceVersion: 1\nid: learning\ntitle: Learning\nslug: learning\nmodules:\n  - id: basics\n    title: Basics\n    slug: basics\n    order: 1\n    pages: [one, two]\n",
    "one.md": page("one", "first", 1, `# One\n\n${badCallout}`),
    "two.md": page(
      "two",
      "second",
      2,
      "# Two\n\n[By path](./one.md)\n\n[By route](/basics/first)\n\n[Gone](./nope.md)\n",
    ),
  });

  expect(summary(await lint({ dir }))).toEqual({
    diagnostics: [
      ["attribute-value-invalid", "one.md", [9], "error"],
      ["link-page-not-found", "two.md", [13], "error"],
    ],
    failures: [],
  });
});

test("an undeclared author is reported, and links are still checked", async () => {
  const dir = await fixture({
    ".topik.yaml":
      "version: 1\nnamespace: example/lint\nsources:\n  - kind: collection\n    config: collection.yaml\n",
    "collection.yaml": "sourceVersion: 1\nid: guides\ntitle: Guides\n",
    "intro.md":
      "---\nid: guides-intro\nslug: intro\nauthors: [nobody]\n---\n# Intro\n\n[Gone](./nope.md)\n",
  });

  const result = await lint({ dir });
  expect(summary(result)).toEqual({
    diagnostics: [["link-page-not-found", "intro.md", [8], "error"]],
    failures: [["PublicCompileError", []]],
  });
  expect(result.failures[0].error).toMatchObject({ id: "author-not-found", location: "intro.md" });
});
