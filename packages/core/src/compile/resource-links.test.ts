import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vite-plus/test";
import { compileManifest } from "./manifest";
import { compileGuides } from "./guide";
import { compileWiki } from "./wiki";
import type { CompileResourceReferenceTarget } from "./links";
import { createProjectAssetNameGenerator } from "./asset-names";

const roots: string[] = [];
async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "topik-resource-links-"));
  roots.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const manifest = JSON.stringify({
  version: 1,
  namespace: "example/references",
  sources: [
    { kind: "wiki", config: "docs/wiki.yaml" },
    { kind: "collection", config: "guides/collection.yaml" },
  ],
});
const wikiConfig =
  "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation:\n  - type: page\n    slug: overview\n    source: pages/start\n";
const guideConfig = "id: training\ntitle: Training\nsourceVersion: 1\n";

test("compiles links across declared Wiki and Guide sources using names rather than routes", async () => {
  const authoredWiki =
    '---\nid: overview-page\n---\n# Overview\n\n[Install](../../guides/install.md?view=a%20b&view=c#setup)\n\n{% card title="Install card" href="../../guides/install.md#setup" /%}\n';
  const authoredGuide =
    "---\nid: installation-guide\nslug: getting-started\ntitle: Installation\n---\n# Installation\n\n## Setup\n\n[Overview](../docs/pages/start.md#overview)\n";
  const dir = await fixture({
    ".topik.yaml": manifest,
    "docs/wiki.yaml": wikiConfig,
    "docs/pages/start.md": authoredWiki,
    "guides/collection.yaml": guideConfig,
    "guides/install.md": authoredGuide,
  });
  const result = await compileManifest({ dir });
  const page = result.resources.find((resource) => resource.type === "WikiPage")!;
  const guide = result.resources.find((resource) => resource.type === "Guide")!;
  expect(page.spec.content.value).toContain(
    "ref://guide/installation-guide?view=a%20b&view=c#setup",
  );
  expect(page.spec.content.value).toContain('href="ref://guide/installation-guide#setup"');
  expect(guide.spec.content.value).toContain("ref://wiki-page/overview-page#overview");
  expect(result.references).toHaveLength(3);
  expect(result.references.map((reference) => reference.status)).toEqual([
    "verified",
    "verified",
    "verified",
  ]);
  expect(
    result.references.find((reference) => reference.href.startsWith("../../guides/install.md?")),
  ).toMatchObject({
    resource: "WikiPage/overview-page",
    sourcePath: "docs/pages/start.md",
    href: "../../guides/install.md?view=a%20b&view=c#setup",
    reference: {
      type: "Guide",
      name: "installation-guide",
      search: "?view=a%20b&view=c",
      hash: "setup",
    },
  });
  expect(result.payloads).toEqual([]);
  expect(await readFile(join(dir, "docs/pages/start.md"), "utf8")).toBe(authoredWiki);
  expect(await readFile(join(dir, "guides/install.md"), "utf8")).toBe(authoredGuide);
  const reversed = JSON.parse(manifest) as { sources: unknown[] };
  reversed.sources.reverse();
  await writeFile(join(dir, ".topik.yaml"), JSON.stringify(reversed));
  const reordered = await compileManifest({ dir });
  expect(reordered.resources).toEqual(result.resources);
  expect(reordered.references).toEqual(result.references);
});

test("standalone Guide compilation rewrites inline and reference links while preserving ordinary URLs", async () => {
  const dir = await fixture({
    "collection.yaml": guideConfig,
    "intro.md":
      '---\nid: introduction\nslug: start-here\ntitle: Introduction\n---\n# Introduction\n\n[Install][install]\n[External](https://example.com/install.md)\n[Web route](/app/help)\n[Local](#introduction)\n\n[install]: ./install.mdx#setup "Installation"\n',
    "install.mdx": "---\nid: installation\nslug: public-install\ntitle: Install\n---\n# Setup\n",
  });
  const result = await compileGuides({ dir });
  const introduction = result.resources.find((resource) => resource.name === "introduction")!;
  expect(introduction.spec).toMatchObject({
    content: { value: expect.stringContaining("[install]: ref://guide/installation#setup") },
  });
  const value = result.resources.find((resource) => resource.name === "introduction");
  if (value?.type !== "Guide") throw new Error("Expected the introduction Guide");
  expect(value.spec.content.value).toContain("https://example.com/install.md");
  expect(value.spec.content.value).toContain("/app/help");
  expect(value.spec.content.value).toContain("(#introduction)");
  expect(result.references).toMatchObject([{ href: "./install.mdx#setup", status: "verified" }]);
});

test("normalizes authored refs and records unknown references for application resolution", async () => {
  const dir = await fixture({
    "collection.yaml": guideConfig,
    "intro.md":
      "---\nid: introduction\nslug: intro\ntitle: Introduction\n---\n# Introduction\n\n[Self](REF://GUIDE/%69ntroduction#introduction)\n[Elsewhere](ref://wiki-page/remote-page?mode=full#details)\n",
  });
  const result = await compileGuides({ dir });
  const guide = result.resources.find((resource) => resource.type === "Guide")!;
  expect(guide.spec.content.value).toContain("ref://guide/introduction#introduction");
  expect(result.references.map(({ status }) => status)).toEqual(["verified", "deferred"]);
});

test.each([1, 8192])(
  "normalizes source links with %i repeated separators and trailing slashes",
  async (count) => {
    const slashes = "/".repeat(count);
    const href = `.${slashes}install.md${slashes}?view=full#setup`;
    const dir = await fixture({
      "collection.yaml": guideConfig,
      "intro.md": `---\nid: introduction\nslug: intro\ntitle: Introduction\n---\n# Introduction\n\n[Install](${href})\n`,
      "install.md": "---\nid: installation\nslug: install\ntitle: Install\n---\n# Setup\n",
    });
    const result = await compileGuides({ dir });
    const introduction = result.resources.find((resource) => resource.name === "introduction")!;
    expect(introduction.spec).toMatchObject({
      content: { value: expect.stringContaining("ref://guide/installation?view=full#setup") },
    });
    expect(result.references).toMatchObject([{ href, status: "verified" }]);
    expect(result.diagnostics).toEqual([]);
  },
);

test("validates authored local resource fragments and keeps warning status explicit", async () => {
  const dir = await fixture({
    "collection.yaml": guideConfig,
    "intro.md":
      "---\nid: introduction\nslug: intro\ntitle: Introduction\n---\n# Introduction\n\n[Self](ref://guide/introduction#missing)\n",
  });
  await expect(compileGuides({ dir })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ id: "link-fragment-not-found", file: "intro.md" })],
  });
  const warning = await compileGuides({ dir, validation: { links: "warning" } });
  expect(warning.references[0].status).toBe("invalid");
  expect(warning.diagnostics[0]).toMatchObject({ id: "link-fragment-not-found", level: "warning" });
});

test("supplied target catalogues validate explicit external references without importing source files", async () => {
  const dir = await fixture({
    "collection.yaml": guideConfig,
    "intro.md":
      "---\nid: introduction\nslug: intro\ntitle: Introduction\n---\n# Introduction\n\n[External](ref://wiki-page/external#details)\n[No metadata](ref://guide/other#setup)\n[No fragment](ref://guide/other)\n",
  });
  const result = await compileGuides({
    dir,
    referenceTargets: [
      { type: "WikiPage", name: "external", headings: ["details"] },
      { type: "Guide", name: "other" },
    ],
  });
  expect(result.references.map(({ status }) => status)).toEqual([
    "verified",
    "deferred",
    "verified",
  ]);
  expect(result.resources).toHaveLength(1);
  await expect(
    compileGuides({
      dir,
      referenceTargets: [{ type: "WikiPage", name: "external", headings: [] }],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ id: "link-fragment-not-found" })],
  });
});

test("supplied duplicate targets are ambiguous and actual local resources remain authoritative", async () => {
  const dir = await fixture({
    "collection.yaml": guideConfig,
    "intro.md":
      "---\nid: introduction\nslug: intro\ntitle: Introduction\n---\n# Introduction\n\n[Self](ref://guide/introduction#introduction)\n[External](ref://guide/other)\n",
  });
  const result = await compileGuides({
    dir,
    validation: { links: "warning" },
    referenceTargets: [
      { type: "Guide", name: "introduction", headings: [] },
      { type: "Guide", name: "other" },
      { type: "Guide", name: "other" },
    ],
  });
  expect(result.references.map(({ status }) => status)).toEqual(["verified", "invalid"]);
  expect(result.diagnostics).toMatchObject([{ id: "link-reference-ambiguous", level: "warning" }]);
});

test("rejects undeclared source-file links instead of packaging their Markdown as Assets", async () => {
  const dir = await fixture({
    "wiki.yaml": "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [start]\n",
    "start.md": "---\nid: start-page\n---\n# Start\n\n[Undeclared](./private.md)\n",
    "private.md": "# Private source\n",
  });
  await expect(compileWiki({ dir })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ id: "link-page-not-found" })],
  });
});

test("broken cross-resource fragments report the linking project-relative source", async () => {
  const dir = await fixture({
    ".topik.yaml": manifest,
    "docs/wiki.yaml": wikiConfig,
    "docs/pages/start.md":
      "---\nid: overview-page\n---\n# Overview\n\n[Install](../../guides/install.md#missing)\n",
    "guides/collection.yaml": guideConfig,
    "guides/install.md": "---\nid: installation\nslug: install\ntitle: Install\n---\n# Setup\n",
  });
  await expect(compileManifest({ dir })).rejects.toMatchObject({
    diagnostics: [
      expect.objectContaining({ id: "link-fragment-not-found", file: "docs/pages/start.md" }),
    ],
  });
});

test.each([
  { case: "non-array catalogue", value: {} },
  { case: "null entry", value: [null] },
  { case: "unknown kind", value: [{ type: "Wiki", name: "other" }] },
  { case: "invalid name", value: [{ type: "Guide", name: "credential-secret/other" }] },
  { case: "substring headings", value: [{ type: "Guide", name: "other", headings: "setupXYZ" }] },
  { case: "non-array headings", value: [{ type: "Guide", name: "other", headings: 123 }] },
  { case: "non-string heading", value: [{ type: "Guide", name: "other", headings: ["setup", 1] }] },
])("rejects malformed supplied resource catalogues: $case", async ({ value }) => {
  const dir = await fixture({
    "collection.yaml": "id: training\ntitle: Training\n",
    "intro.md": "# Introduction\n\n[External](ref://guide/other#setup)\n",
  });
  await expect(
    compileGuides({ dir, referenceTargets: value as readonly CompileResourceReferenceTarget[] }),
  ).rejects.toMatchObject({
    name: "PublicCompileError",
    id: "reference-targets-invalid",
    message: "Resource reference target catalogue is invalid.",
  });
});

test("distinguishes declared Markdown extensions and diagnoses an absent exact source", async () => {
  const dir = await fixture({
    "collection.yaml": guideConfig,
    "intro.md":
      "---\nid: intro\nslug: intro\ntitle: Introduction\n---\n# Introduction\n\n[Markdown](./target.md)\n[MDX](./target.mdx)\n",
    "target.md": "---\nid: target-markdown\nslug: markdown\ntitle: Markdown\n---\n# Markdown\n",
    "target.mdx": "---\nid: target-mdx\nslug: mdx\ntitle: MDX\n---\n# MDX\n",
  });
  const result = await compileGuides({ dir });
  expect(result.references.map(({ reference }) => reference.name)).toEqual([
    "target-markdown",
    "target-mdx",
  ]);
  await rm(join(dir, "target.mdx"));
  await expect(compileGuides({ dir })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ id: "link-page-not-found" })],
  });
});

test("Wiki fallback cannot rebind an absent Markdown extension or an escaping source path", async () => {
  const dir = await fixture({
    "wiki.yaml": "id: docs\ntitle: Docs\nnavigation: [start]\n",
    "start.md": "# Start\n\n[Wrong extension](./start.mdx)\n[Outside root](../../start)\n",
  });
  await expect(compileWiki({ dir })).rejects.toMatchObject({
    diagnostics: [
      expect.objectContaining({ id: "link-page-not-found" }),
      expect.objectContaining({ id: "link-page-not-found" }),
    ],
  });
});

test("a non-Markdown download and app route do not resolve to a similarly named Guide source", async () => {
  const dir = await fixture({
    "collection.yaml": guideConfig,
    "intro.md":
      "---\nid: intro\nslug: intro\ntitle: Introduction\n---\n# Introduction\n\n[Download](./api.json)\n[Application](/api.json)\n[Guide](./api.json.md)\n",
    "api.json.md":
      "---\nid: api-guide\nslug: api-reference\ntitle: API Reference\n---\n# API Reference\n",
    "api.json": "{}\n",
  });
  const result = await compileGuides({
    dir,
    assets: {
      generateName: createProjectAssetNameGenerator({
        projectRoot: dir,
        projectNamespace: "example/non-markdown",
      }),
    },
  });
  const introduction = result.resources.find((resource) => resource.name === "intro");
  if (introduction?.type !== "Guide") throw new Error("Expected introduction Guide");
  expect(introduction.spec.content.value).toContain("[Download](asset:auto-v1-");
  expect(introduction.spec.content.value).toContain("[Application](/api.json)");
  expect(introduction.spec.content.value).toContain("[Guide](ref://guide/api-guide)");
  expect(result.references).toMatchObject([
    { href: "./api.json.md", reference: { type: "Guide", name: "api-guide" } },
  ]);
  expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
  expect(result.payloads).toHaveLength(1);
});

test("a Wiki file download does not fall back to a dotted source alias", async () => {
  const dir = await fixture({
    "wiki.yaml":
      "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation:\n  - start\n  - type: page\n    slug: api-reference\n    source: api.json\n",
    "start.md": "# Start\n\n[Download](./api.json)\n",
    "api.json.md": "# API reference\n",
    "api.json": "{}\n",
  });
  const result = await compileWiki({
    dir,
    assets: {
      generateName: createProjectAssetNameGenerator({
        projectRoot: dir,
        projectNamespace: "example/non-markdown",
      }),
    },
  });
  expect(result.references).toEqual([]);
  expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
});
