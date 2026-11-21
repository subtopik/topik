import { expect, test, vi } from "vite-plus/test";
import { digestSourceResourceGraph, readSourceProject, snapshotSourceTree } from "./project";
import { planSourceUpdates } from "./plan";
import { encodeSource } from "./syntax";
import { resolveWikiContentHref, resolveWikiNavigation } from "../wiki-navigation";

const file = (path: string, value: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(value),
});

test.each(["wiki", "course"] as const)(
  "%s source provenance excludes compiled downloads from page lookup",
  async (kind) => {
    const configuration =
      "id: docs\ntitle: Docs\n" +
      (kind === "wiki"
        ? "navigation: [home, manual, other]\n"
        : "slug: docs\nmodules: [{id: basics, title: Basics, slug: basics, pages: [home, manual, other]}]\n");
    const page = (id: string, body: string) =>
      `---\nid: ${id}\nslug: ${id}\ntitle: ${id}\n---\n${body}`;
    const project = await readSourceProject({
      tree: [
        file(
          ".topik.yaml",
          `version: 1\nnamespace: refs\nsources: [{kind: ${kind}, config: config.yaml}]\n`,
        ),
        file("config.yaml", configuration),
        file(
          "home.md",
          page(
            "home",
            [
              "# Home",
              "[Download][download]",
              "> - [Again][download]",
              "[Page](./manual.md)",
              `{% card title="Page" href="${kind === "wiki" ? "./manual" : "ref://guide/remote"}" /%}`,
              "[Self](#home)",
              "[download]: ./manual",
            ].join("\n\n") + "\n",
          ),
        ),
        file("manual.md", page("manual-page", "# Manual\n")),
        file("other.md", page("other", "# Other\n\n[Page](./manual.md)\n")),
        file("manual", "Download bytes.\n"),
      ],
    });
    const type = kind === "wiki" ? "WikiPage" : "CoursePage";
    const home = project.documents.find((document) => document.resource === `${type}/home`)!;
    const downloads = home.references.filter(
      (reference) => reference.kind === "link" && reference.href === "./manual",
    );
    expect(downloads).toHaveLength(2);
    for (const download of downloads) {
      expect(download.target).toBeUndefined();
      expect(download.search).toBeUndefined();
      expect(download.hash).toBeUndefined();
    }
    expect(home.assetReferences).toHaveLength(1);
    expect(
      project.compilation.semantic.references.filter(
        (reference) => reference.resource === `${type}/home` && reference.slot === "link.href",
      ),
    ).toHaveLength(2);
    expect(home.references.find((reference) => reference.href === "./manual.md")?.target).toBe(
      `${type}/manual-page`,
    );
    expect(home.references.find((reference) => reference.kind === "card")?.target).toBe(
      kind === "wiki" ? "WikiPage/manual-page" : "Guide/remote",
    );
    expect(home.references.find((reference) => reference.href === "#home")?.target).toBe(
      `${type}/home`,
    );
    expect(
      project.documents.find((document) => document.resource === `${type}/other`)?.references,
    ).toMatchObject([{ position: "1/0", href: "./manual.md", target: `${type}/manual-page` }]);
  },
);

test("source provenance retains authored links and records cross-kind and deferred reference targets", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: refs\nsources: [{kind: wiki, config: docs/wiki.yaml}, {kind: collection, config: guides/collection.yaml}]\n",
      ),
      file("docs/wiki.yaml", "id: docs\ntitle: Docs\nnavigation: [index]\n"),
      file(
        "docs/index.md",
        "---\nid: home\n---\n# Home\n\n[Install](../guides/install.md#setup)\n",
      ),
      file("guides/collection.yaml", "id: guides\ntitle: Guides\n"),
      file(
        "guides/install.md",
        "---\nid: install\n---\n# Setup\n\n[Home](ref://wiki-page/home)\n\n[Elsewhere](ref://guide/external-guide?view=full#details)\n",
      ),
    ],
  });
  expect(
    project.documents.find((document) => document.resource === "WikiPage/home")?.references,
  ).toMatchObject([
    { href: "../guides/install.md#setup", target: "Guide/install", search: "", hash: "setup" },
  ]);
  expect(
    project.documents.find((document) => document.resource === "Guide/install")?.references,
  ).toMatchObject([
    { href: "ref://wiki-page/home", target: "WikiPage/home" },
    {
      href: "ref://guide/external-guide?view=full#details",
      target: "Guide/external-guide",
      search: "?view=full",
      hash: "details",
    },
  ]);
});

test("aggregate source-tree limits reject reused buffers before any byte copy", () => {
  const ByteArray = Uint8Array;
  const bytes = new ByteArray(64 * 1024 * 1024);
  const copies = vi.fn();
  vi.stubGlobal(
    "Uint8Array",
    new Proxy(ByteArray, {
      construct(target, args) {
        if (args[0] instanceof ByteArray) copies();
        return Reflect.construct(target, args);
      },
    }),
  );
  try {
    expect(() =>
      snapshotSourceTree(
        Array.from({ length: 9 }, (_, index) => ({
          path: `file-${index}.md`,
          mode: "100644",
          bytes,
        })),
      ),
    ).toThrow("aggregate byte limit");
    expect(copies).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("desired graph seals exact authored content while resource ordering is irrelevant", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: docs\nsources: [{kind: wiki, config: wiki.yaml}]\n",
      ),
      file("wiki.yaml", "id: docs\ntitle: Docs\nnavigation: [index]\n"),
      file("index.md", "# Home\n"),
    ],
  });
  const resources = project.compilation.resources;
  expect(digestSourceResourceGraph(resources)).toBe(
    digestSourceResourceGraph([...resources].reverse()),
  );
  const changed = structuredClone(resources);
  const page = changed.find((resource) => resource.type === "WikiPage")!;
  page.spec.content.value += "\n";
  expect(digestSourceResourceGraph(changed)).not.toBe(digestSourceResourceGraph(resources));
});

test("field origins distinguish explicit and inherited tags, overrides, derived titles and absent defaults", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/provenance\nsources: [{kind: collection, config: blog/source.yml}]\n",
      ),
      file(
        "blog/source.yml",
        "id: blog\ntitle: Blog\ntags: [shared]\npersons: [{id: ada, spec: {name: Ada, email: null}}]\n",
      ),
      file(
        "blog/first.md",
        "---\nid: first\ntags: [local]\nauthors: [ada]\n---\n# Inferred title\n",
      ),
      file(
        "blog/second.md",
        "---\nid: second\ntitle: Explicit\ninheritTags: false\ntags: []\n---\n# Body\n",
      ),
    ],
  });
  const first = project.documents.find((document) => document.resource === "Guide/first")!;
  expect(first.fieldOrigins.filter((field) => field.field === "spec/tags")).toMatchObject([
    { origin: "inherited", path: "blog/source.yml", selector: "tags" },
    { origin: "explicit", path: "blog/first.md", selector: "tags" },
  ]);
  expect(first.fieldOrigins.find((field) => field.field === "spec/title")).toMatchObject({
    origin: "derived",
    range: first.body,
  });
  expect(first.fieldOrigins.find((field) => field.field === "spec/description")).toMatchObject({
    origin: "default",
  });
  const second = project.documents.find((document) => document.resource === "Guide/second")!;
  expect(second.fieldOrigins.filter((field) => field.field === "spec/tags")).toMatchObject([
    { origin: "explicit" },
  ]);
  const person = project.documents.find((document) => document.resource === "Person/ada")!;
  const email = person.fieldOrigins.find((field) => field.field === "spec/email")!;
  expect(email).toMatchObject({ origin: "explicit", selector: "persons/ada/spec/email" });
  expect(
    new TextDecoder().decode(
      project.tree
        .find((file) => file.path === person.path)!
        .bytes.slice(email.range!.start, email.range!.end),
    ),
  ).toBe("null");
});

test("retained source context resolves saved links after candidate source moves", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/context\nsources: [{kind: wiki, config: docs/custom.yaml}]\n",
      ),
      file(
        "docs/custom.yaml",
        "id: docs\ntitle: Docs\nnavigation: [{type: page, slug: start, source: pages/start}, {type: page, slug: target, source: pages/target, hidden: true}]\n",
      ),
      file("docs/pages/start.md", "---\nid: start\n---\n[Target](target.md?view=full#section)\n"),
      file("docs/pages/target.md", "---\nid: target\n---\n# Section\n"),
    ],
  });
  const document = project.documents.find((document) => document.resource === "WikiPage/start")!;
  expect(document.sourceContext).toEqual({
    path: "pages/start.md",
    extension: ".md",
    wiki: "Wiki/docs",
  });
  expect(document.references).toMatchObject([
    { kind: "link", target: "WikiPage/target", search: "?view=full", hash: "section" },
  ]);
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: "a".repeat(64),
    desiredResources: project.compilation.resources,
    operations: [{ kind: "move", resource: "WikiPage/target", path: "docs/moved/target.md" }],
    authority: {
      resources: ["Wiki/docs", "WikiPage/start", "WikiPage/target"],
      exclusive: project.documents
        .filter((document) => document.body)
        .map(({ path, sha256, mode }) => ({ path, sha256, mode })),
      shared: project.configurations.filter((config) => config.path !== ".topik.yaml"),
      create: ["docs/moved/target.md"],
    },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const originalWiki = project.wikiContexts[document.sourceContext.wiki!];
  expect(
    resolveWikiContentHref(
      document.references[0].href,
      "start",
      resolveWikiNavigation(originalWiki.spec.navigation ?? []),
    )?.page.page,
  ).toBe("target");
  expect(
    result.plan.candidate.documents.find((document) => document.resource === "WikiPage/start")!
      .references,
  ).toMatchObject([{ target: "WikiPage/target", search: "?view=full", hash: "section" }]);
  expect(project.wikiContexts["Wiki/docs"]).not.toEqual(
    result.plan.candidate.wikiContexts["Wiki/docs"],
  );
});

test.skipIf(process.platform === "win32")(
  "inspection ignores a Git repository above the temporary directory",
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const repository = await mkdtemp(join(tmpdir(), "topik-scratch-ancestor-"));
    const previous = process.env.TMPDIR;
    try {
      execFileSync("/usr/bin/git", ["init", "-q", repository]);
      // Attributes that would make every scratch file look filtered by Git LFS.
      await writeFile(join(repository, ".gitattributes"), "*.md filter=lfs\n*.yaml filter=lfs\n");
      await mkdir(join(repository, "tmp"));
      process.env.TMPDIR = join(repository, "tmp");
      const project = await readSourceProject({
        tree: [
          {
            path: ".topik.yaml",
            mode: "100644",
            bytes: encodeSource(
              "version: 1\nnamespace: example/docs\nsources: [{kind: collection, config: guides/collection.yaml}]\n",
            ),
          },
          {
            path: "guides/collection.yaml",
            mode: "100644",
            bytes: encodeSource("id: guides\ntitle: Guides\n"),
          },
          { path: "guides/start.md", mode: "100644", bytes: encodeSource("# Start\n") },
        ],
      });
      expect(project.compilation.resources.map((resource) => resource.type)).toContain("Guide");
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(repository, { recursive: true, force: true });
    }
  },
);
