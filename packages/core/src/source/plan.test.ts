import { expect, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import type { Wiki } from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import { readSourceProject, type SourceTreeFile, type SourceProject } from "./project";
import { planSourceUpdates, type SourceWriteAuthority } from "./plan";
import { encodeSource, decodeSource, sourceHash } from "./syntax";
import { generateAutomaticAssetName, parseAssetBlobUri } from "../assets/asset";

const cohort = "a".repeat(64);

test("editing compiled content preserves each authored relative or explicit reference spelling", async () => {
  const raw =
    "---\nid: home\n---\n# Home\n\n[Relative](./install.md?view=full#setup)\n\n[Explicit](ref://wiki-page/install#setup)\n";
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: refs\nsources: [{kind: wiki, config: wiki.yaml}]\n",
      ),
      file("wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [home, install]\n"),
      file("home.md", raw),
      file("install.md", "---\nid: install\n---\n# Setup\n"),
    ],
  });
  const unchanged = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: project.compilation.resources,
    operations: [],
    authority: authority(project),
  });
  expect(unchanged.ok, JSON.stringify(unchanged)).toBe(true);
  if (unchanged.ok) expect(unchanged.plan.changes).toEqual([]);
  const desired = structuredClone(project.compilation.resources);
  const home = desired.find(
    (resource): resource is WikiPage => resource.type === "WikiPage" && resource.name === "home",
  )!;
  home.spec.content.value += "\nAdded paragraph.\n";
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "WikiPage/home" }],
    authority: authority(project),
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const written = decodeSource(
    result.plan.candidate.tree.find((entry) => entry.path === "home.md")!.bytes,
  );
  expect(written).toContain("[Relative](./install.md?view=full#setup)");
  expect(written).toContain("[Explicit](ref://wiki-page/install#setup)");
  expect(result.plan.candidate.compilation.resources).toEqual(desired);
  const wiki = desired.find((resource): resource is Wiki => resource.type === "Wiki")!;
  const install = wiki.spec.navigation!.find(
    (node) => node.type === "page" && node.page === "install",
  )!;
  if (install.type !== "page") throw new Error("Expected a page");
  install.slug = "public-install";
  const routeEdit = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [
      { kind: "update", resource: "WikiPage/home" },
      { kind: "update", resource: "Wiki/docs" },
    ],
    authority: authority(project),
  });
  expect(routeEdit.ok, JSON.stringify(routeEdit)).toBe(true);
});

test("cross-kind relative links are repaired on moves and stale locally owned refs block deletion", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: refs\nsources: [{kind: wiki, config: docs/wiki.yaml}, {kind: collection, config: guides/collection.yaml}]\n",
      ),
      file("docs/wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [home]\n"),
      file("docs/home.md", "---\nid: home\n---\n# Home\n\n[Install](../guides/install.md#setup)\n"),
      file("guides/collection.yaml", "id: guides\ntitle: Guides\nsourceVersion: 1\n"),
      file("guides/install.md", "---\nid: install\n---\n# Setup\n\n[Home](../docs/home.md)\n"),
    ],
  });
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: project.compilation.resources,
    operations: [{ kind: "move", resource: "Guide/install", path: "guides/renamed.md" }],
    authority: { ...authority(project), create: ["guides/renamed.md"] },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) {
    expect(result.plan.candidate.compilation.resources).toEqual(project.compilation.resources);
    expect(
      decodeSource(
        result.plan.candidate.tree.find((entry) => entry.path === "docs/home.md")!.bytes,
      ),
    ).toContain("../guides/renamed.md#setup");
    expect(result.plan.derivedRepairs).toContainEqual(
      expect.objectContaining({ resource: "WikiPage/home", kind: "reference", target: "install" }),
    );
    const moved = result.plan.candidate;
    const edited = structuredClone(moved.compilation.resources);
    edited.find((resource): resource is Guide => resource.type === "Guide")!.spec.content.value +=
      "\nAdded guide text.\n";
    const saved = await planSourceUpdates({
      project: moved,
      expectedTreeDigest: moved.treeDigest,
      packageCohort: cohort,
      desiredResources: edited,
      operations: [{ kind: "update", resource: "Guide/install" }],
      authority: authority(moved),
    });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    if (saved.ok)
      expect(
        decodeSource(
          saved.plan.candidate.tree.find((entry) => entry.path === "guides/renamed.md")!.bytes,
        ),
      ).toContain("[Home](../docs/home.md)");
  }
  expect(
    await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: project.compilation.resources.filter(
        (resource) => resource.type !== "Guide",
      ),
      operations: [{ kind: "delete", resource: "Guide/install" }],
      authority: authority(project),
    }),
  ).toMatchObject({
    ok: false,
    diagnostics: [{ code: "reference-target-removed", resource: "WikiPage/home" }],
  });
});

test("fresh relative links across resource kinds preserve authored spelling and explicit source extensions", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: refs\nsources: [{kind: wiki, config: docs/wiki.yaml}, {kind: collection, config: guides/collection.yaml}, {kind: course, config: lessons/course.yaml}]\n",
      ),
      file("docs/wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [home]\n"),
      file("docs/home.md", "---\nid: home\n---\n# Home\n"),
      file("guides/collection.yaml", "id: guides\ntitle: Guides\nsourceVersion: 1\n"),
      file("guides/install.md", "---\nid: install-md\nslug: install-markdown\n---\n# Setup\n"),
      file("guides/install.mdx", "---\nid: install-mdx\nslug: install-mdx\n---\n# Other\n"),
      file(
        "lessons/course.yaml",
        "sourceVersion: 1\nid: lessons\ntitle: Lessons\nslug: lessons\nmodules: [{id: basics, title: Basics, slug: basics, order: 0, pages: [intro]}]\n",
      ),
      file(
        "lessons/intro.md",
        "---\nid: tutorial\ntitle: Intro\nslug: intro\norder: 0\n---\n# Intro\n",
      ),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  desired.find(
    (resource): resource is WikiPage => resource.type === "WikiPage",
  )!.spec.content.value = "# Home\n\n[Install](../guides/install.md#setup)\n";
  desired.find(
    (resource): resource is Guide => resource.type === "Guide" && resource.name === "install-md",
  )!.spec.content.value = "# Setup\n\n[Home](../docs/home.md?view=full#home)\n";
  desired.find(
    (resource): resource is CoursePage => resource.type === "CoursePage",
  )!.spec.content.value = "# Intro\n\n[Install](../guides/install.md#setup)\n";
  const request = {
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [
      { kind: "update" as const, resource: "WikiPage/home" },
      { kind: "update" as const, resource: "Guide/install-md" },
      { kind: "update" as const, resource: "CoursePage/tutorial" },
    ],
    authority: authority(project),
  };
  const saved = await planSourceUpdates(request);
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  if (saved.ok) {
    expect(
      saved.plan.candidate.compilation.resources.find(
        (resource): resource is WikiPage => resource.type === "WikiPage",
      )!.spec.content.value,
    ).toContain("ref://guide/install-md#setup");
    expect(
      decodeSource(saved.plan.candidate.tree.find((entry) => entry.path === "docs/home.md")!.bytes),
    ).toContain("[Install](../guides/install.md#setup)");
    expect(
      decodeSource(
        saved.plan.candidate.tree.find((entry) => entry.path === "guides/install.md")!.bytes,
      ),
    ).toContain("[Home](../docs/home.md?view=full#home)");
    expect(
      decodeSource(
        saved.plan.candidate.tree.find((entry) => entry.path === "lessons/intro.md")!.bytes,
      ),
    ).toContain("[Install](../guides/install.md#setup)");
  }
  const moved = await planSourceUpdates({
    ...request,
    operations: [
      { kind: "update", resource: "WikiPage/home" },
      { kind: "move", resource: "Guide/install-md", path: "guides/renamed.md" },
      { kind: "update", resource: "CoursePage/tutorial" },
    ],
    authority: { ...request.authority, create: ["guides/renamed.md"] },
  });
  expect(moved.ok, JSON.stringify(moved)).toBe(true);
  if (moved.ok)
    expect(
      decodeSource(moved.plan.candidate.tree.find((entry) => entry.path === "docs/home.md")!.bytes),
    ).toContain("[Install](../guides/renamed.md#setup)");
});
test("fresh non-Markdown application links remain distinct from dotted Guide source stems", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: refs\nsources: [{kind: collection, config: guides/collection.yaml}]\n",
      ),
      file("guides/collection.yaml", "id: guides\ntitle: Guides\nsourceVersion: 1\n"),
      file("guides/intro.md", "---\nid: intro\n---\n# Intro\n"),
      file("guides/api.json.md", "---\nid: api-guide\nslug: api-reference\n---\n# API\n"),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  desired.find(
    (resource): resource is Guide => resource.type === "Guide" && resource.name === "intro",
  )!.spec.content.value =
    "# Intro\n\n[Application](./api.json)\n[Guide](./api.json.md?view=full#api)\n";
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Guide/intro" }],
    authority: authority(project),
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const intro = result.plan.candidate.compilation.resources.find(
    (resource): resource is Guide => resource.type === "Guide" && resource.name === "intro",
  )!;
  expect(intro.spec.content.value).toContain("[Application](./api.json)");
  expect(intro.spec.content.value).toContain("[Guide](ref://guide/api-guide?view=full#api)");
  expect(
    decodeSource(
      result.plan.candidate.tree.find((entry) => entry.path === "guides/intro.md")!.bytes,
    ),
  ).toContain("[Guide](./api.json.md?view=full#api)");
});

test.each(["yaml", "json"])(
  "BOM-prefixed %s config edits retain original byte coordinates",
  async (format) => {
    const path = `wiki.${format}`;
    const raw =
      format === "yaml"
        ? "\uFEFFid: docs\r\ntitle: Docs # keep\r\nsourceVersion: 1\r\nnavigation: []\r\ncustom: exact\r\n"
        : '\uFEFF{\r\n  "id": "docs",\r\n  "title": "Docs",\r\n  "sourceVersion": 1,\r\n  "navigation": [],\r\n  "custom": "exact"\r\n}\r\n';
    const project = await readSourceProject({
      tree: [
        file(
          ".topik.yaml",
          `version: 1\nnamespace: example/bom\nsources: [{kind: wiki, config: ${path}}]\n`,
        ),
        file(path, raw),
      ],
    });
    const desired = structuredClone(project.compilation.resources);
    desired.find((resource) => resource.type === "Wiki")!.spec.title = "Edited";
    const config = project.configurations.find((config) => config.path === path)!;
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [{ kind: "update", resource: "Wiki/docs" }],
      authority: {
        resources: ["Wiki/docs"],
        exclusive: [],
        create: [],
        shared: [
          { ...config, fields: config.fields.filter((field) => field.selector === "title") },
        ],
      },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.plan.candidate.compilation.resources).toEqual(desired);
    expect(result.plan.changes).toHaveLength(1);
    expect(result.plan.changes[0].candidate!.bytes).toEqual(
      encodeSource(
        raw.replace(
          format === "yaml" ? "title: Docs" : '"title": "Docs"',
          format === "yaml" ? 'title: "Edited"' : '"title": "Edited"',
        ),
      ),
    );
  },
);
test("an unresolved saved link cannot acquire a target from changed navigation", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/wiki\nsources: [{kind: wiki, config: wiki.yaml}]\n",
      ),
      file("wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [a, b]\n"),
      file("a.md", "---\nid: a\n---\n# A\n"),
      file("b.md", "---\nid: b\n---\n# B\n"),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  const wiki = desired.find((resource) => resource.type === "Wiki")!;
  for (const node of wiki.spec.navigation!)
    if (node.type === "page" && node.page === "b") node.slug = "new";
  desired.find(
    (resource): resource is WikiPage => resource.type === "WikiPage" && resource.name === "a",
  )!.spec.content.value = "# A\n\n[Future](/new)\n";
  expect(
    await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [
        { kind: "update", resource: "Wiki/docs" },
        { kind: "update", resource: "WikiPage/a" },
      ],
      authority: authority(project),
      referenceContexts: { "WikiPage/a": project.wikiContexts["Wiki/docs"] },
    }),
  ).toMatchObject({
    ok: false,
    diagnostics: [{ code: "reference-target-unresolved", resource: "WikiPage/a" }],
  });
});

test("a removed heading reports the unchanged referring page and link diagnostic", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/wiki\nsources: [{kind: wiki, config: wiki.yaml}]\n",
      ),
      file("wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [a, b]\n"),
      file("a.md", "---\nid: a\n---\n# A\n\n[Details](b.md#details)\n"),
      file("b.md", "---\nid: b\n---\n# B\n\n## Details\n"),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  const page = desired.find(
    (resource): resource is WikiPage => resource.type === "WikiPage" && resource.name === "b",
  )!;
  page.spec.content.value = "# B\n\n## Renamed\n";
  expect(
    await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [{ kind: "update", resource: "WikiPage/b" }],
      authority: authority(project),
    }),
  ).toMatchObject({
    ok: false,
    diagnostics: [{ code: "link-fragment-not-found", path: "a.md", lines: [3] }],
  });
});

test("clearing the last block-style label preserves an explicit empty map and surrounding bytes", async () => {
  const original = await guideProject();
  const project = await readSourceProject({
    tree: original.tree.map((entry) =>
      entry.path === "blog/post.md"
        ? file(
            entry.path,
            "---\nid: stable-post\nlabels:\n  one: old\ncustom: exact\n---\n# Original\n",
          )
        : entry,
    ),
  });
  const desired = structuredClone(project.compilation.resources);
  desired.find((resource) => resource.type === "Guide")!.labels = {};
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Guide/stable-post" }],
    authority: authority(project),
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.candidate.compilation.resources).toEqual(desired);
  expect(decodeSource(result.plan.changes[0].candidate!.bytes)).toBe(
    "---\nid: stable-post\nlabels:\n  {}\ncustom: exact\n---\n# Original\n",
  );
});

test("a Guide source move preserves its filename-derived identity and route", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/guide\nsources: [{kind: collection, config: blog/collection.yaml}]\n",
      ),
      file("blog/collection.yaml", "id: blog\ntitle: Blog\nsourceVersion: 1\n"),
      file("blog/old.md", "# A guide\n"),
    ],
  });
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: project.compilation.resources,
    operations: [{ kind: "move", resource: "Guide/blog-old", path: "blog/new.md" }],
    authority: { ...authority(project), create: ["blog/new.md"] },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.candidate.compilation.resources).toEqual(project.compilation.resources);
  expect(
    decodeSource(result.plan.candidate.tree.find((entry) => entry.path === "blog/new.md")!.bytes),
  ).toBe('---\nid: "blog-old"\nslug: "old"\n---\n# A guide\n');
});

test("an incomplete saved Wiki context cannot silently retarget an edited link", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/wiki\nsources: [{kind: wiki, config: wiki.yaml}]\n",
      ),
      file("wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [a, b, c]\n"),
      file("a.md", "---\nid: a\n---\n# A\n\n[Target](/b)\n"),
      file("b.md", "---\nid: b\n---\n# B\n"),
      file("c.md", "---\nid: c\n---\n# C\n"),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  const wiki = desired.find((resource) => resource.type === "Wiki")!;
  for (const node of wiki.spec.navigation!) {
    if (node.type === "page" && node.page === "b") node.slug = "old-b";
    if (node.type === "page" && node.page === "c") node.slug = "b";
  }
  const page = desired.find(
    (resource): resource is WikiPage => resource.type === "WikiPage" && resource.name === "a",
  )!;
  page.spec.content.value = "# A\n\nEdited [Target](/b)\n";
  const context = structuredClone(project.wikiContexts["Wiki/docs"]);
  context.spec.navigation!.splice(0, 1);
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [
      { kind: "update", resource: "Wiki/docs" },
      { kind: "update", resource: "WikiPage/a" },
    ],
    authority: authority(project),
    referenceContexts: { "WikiPage/a": context },
  });
  expect(result).toMatchObject({
    ok: false,
    diagnostics: [{ code: "reference-context-invalid", resource: "WikiPage/a" }],
  });
});

test("a saved media revision creates a new local path while an untouched sibling retains the old Asset", async () => {
  const project = await readSourceProject({
    tree: [
      {
        path: ".topik.yaml",
        mode: "100644",
        bytes: encodeSource(
          "version: 1\nnamespace: media/example\nsources: [{kind: collection, config: docs/collection.yaml}]\n",
        ),
      },
      {
        path: "docs/collection.yaml",
        mode: "100644",
        bytes: encodeSource("id: docs\ntitle: Docs\nsourceVersion: 1\n"),
      },
      {
        path: "docs/first.md",
        mode: "100644",
        bytes: encodeSource("---\nid: first\n---\n[File](file.bin)\n"),
      },
      {
        path: "docs/second.md",
        mode: "100644",
        bytes: encodeSource("---\nid: second\n---\n[File](file.bin)\n"),
      },
      { path: "docs/file.bin", mode: "100644", bytes: encodeSource("old bytes") },
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  const previous = desired.find((resource) => resource.type === "Asset")!;
  if (previous.type !== "Asset") throw new Error("Missing fixture Asset");
  const name = generateAutomaticAssetName({
    projectNamespace: "saved/media",
    manifestRelativePath: "new.bin",
  }).value!;
  const bytes = encodeSource("new bytes");
  desired.push({
    apiVersion: "v1",
    type: "Asset",
    name,
    spec: {
      uri: parseAssetBlobUri(`blobs/${sourceHash(bytes)}`),
      integrity: `sha256:${sourceHash(bytes)}`,
      size: bytes.length,
      mediaType: "application/octet-stream",
    },
  });
  const path = `docs/_assets/revision-${sourceHash(encodeSource(name)).slice(0, 8)}.bin`;
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Guide/first" }],
    assetReferenceContexts: { "Guide/first": { [previous.name]: name } },
    authority: {
      resources: ["Guide/first"],
      exclusive: project.documents
        .filter((document) => document.resource === "Guide/first")
        .map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
      shared: [],
      create: [path],
    },
    media: [
      {
        name,
        filename: "revision.bin",
        config: "docs/collection.yaml",
        sha256: sourceHash(bytes),
        bytes,
      },
    ],
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(
    result.plan.candidate.compilation.resources.filter((resource) => resource.type === "Asset"),
  ).toHaveLength(2);
  expect(result.plan.candidate.tree.find((file) => file.path === "docs/file.bin")).toEqual(
    project.tree.find((file) => file.path === "docs/file.bin"),
  );
  expect(result.plan.changes.map((change) => change.path)).toEqual([path, "docs/first.md"]);
});
test("deleting the last block-list Person keeps a valid empty list within its admitted entry", async () => {
  const project = await guideProject(
    "id: blog\ntitle: Blog\nsourceVersion: 1\npersons:\n  - id: alice\n    spec: {name: Alice}\ncustom: exact\n",
  );
  const admitted = authority(project);
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: project.compilation.resources.filter(
      (resource) => resource.type !== "Person",
    ),
    operations: [{ kind: "delete", resource: "Person/alice" }],
    authority: {
      ...admitted,
      shared: admitted.shared.map((config) => ({
        ...config,
        fields: config.fields.filter((field) => field.selector === "persons/alice"),
      })),
    },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(decodeSource(result.plan.changes[0].candidate!.bytes)).toBe(
    "id: blog\ntitle: Blog\nsourceVersion: 1\npersons:\n  []\ncustom: exact\n",
  );
});
test("edited links require saved context when routes are reassigned", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/wiki\nsources: [{kind: wiki, config: wiki.yaml}]\n",
      ),
      file("wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [old, new]\n"),
      file("old.md", "---\nid: old\n---\n[Target](/old)\n"),
      file("new.md", "---\nid: other\n---\n# Other\n"),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  const wiki = desired.find((resource) => resource.type === "Wiki") as Wiki;
  (wiki.spec.navigation![0] as { slug: string }).slug = "new";
  (wiki.spec.navigation![1] as { slug: string }).slug = "other";
  const page = desired.find(
    (resource) => resource.type === "WikiPage" && resource.name === "old",
  ) as WikiPage;
  page.spec.content.value = "[Target](/new)\n";
  const request = {
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [
      { kind: "update" as const, resource: "Wiki/docs" },
      { kind: "update" as const, resource: "WikiPage/old" },
    ],
    authority: authority(project),
  };
  expect(await planSourceUpdates(request)).toMatchObject({
    ok: false,
    diagnostics: [{ code: "reference-context-required", resource: "WikiPage/old" }],
  });
  const admitted = await planSourceUpdates({
    ...request,
    referenceContexts: { "WikiPage/old": wiki },
  });
  expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
  if (!admitted.ok) return;
  expect(
    decodeSource(admitted.plan.candidate.tree.find((file) => file.path === "old.md")!.bytes),
  ).toContain("[Target](/new)");
});

test("shared Person edits require permission for every referencing Guide", async () => {
  const source = await guideProject(
    "id: blog\ntitle: Blog\nsourceVersion: 1\npersons: [{id: alice, spec: {name: Alice, bio: old}}]\n",
  );
  const project = await readSourceProject({
    tree: [
      ...source.tree,
      file("blog/a.md", "---\nid: first\nauthors: [alice]\n---\n# First\n"),
      file("blog/b.md", "---\nid: sibling\nauthors: [alice]\n---\n# Sibling\n"),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  const person = desired.find((resource) => resource.type === "Person")!;
  if (person.type !== "Person") return;
  person.spec.bio = "Edited";
  const admitted = authority(project);
  const request = {
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update" as const, resource: "Person/alice" }],
    authority: {
      ...admitted,
      resources: admitted.resources.filter((resource) => resource !== "Guide/sibling"),
    },
  };
  expect(await planSourceUpdates(request)).toMatchObject({
    ok: false,
    diagnostics: [{ code: "shared-reference-scope-denied", resource: "Guide/sibling" }],
  });
  const allowed = await planSourceUpdates({ ...request, authority: admitted });
  expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
  if (allowed.ok) expect(allowed.plan.affectedResources).toContain("Guide/sibling");
});
test("supplied media uses the configuration-local destination and returns the identity repair", async () => {
  const project = await guideProject(
    "id: blog\ntitle: Blog\nsourceVersion: 1\nassets: {directory: uploads}\n",
  );
  const bytes = encodeSource("Download these exact bytes.\n");
  const digest = sourceHash(bytes);
  const generated = generateAutomaticAssetName({
    projectNamespace: "hosted/example",
    manifestRelativePath: "file.txt",
  });
  if (!generated.ok) throw new Error("Invalid fixture asset");
  const name = generated.value;
  const desired = structuredClone(project.compilation.resources);
  const guide = desired.find((resource) => resource.type === "Guide") as Guide;
  guide.spec.content.value = `# Original\n\n[Download](asset:${name})\n`;
  desired.push({
    apiVersion: "v1",
    type: "Asset",
    name,
    spec: {
      uri: parseAssetBlobUri(`blobs/${digest}`),
      integrity: `sha256:${digest}`,
      size: bytes.length,
      mediaType: "application/octet-stream",
    },
  });
  const path = `blog/uploads/file-${sourceHash(encodeSource(name)).slice(0, 8)}.txt`;
  const request = {
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update" as const, resource: "Guide/stable-post" }],
    authority: { ...authority(project), create: [path] },
    media: [{ config: "blog/custom.yaml", name, filename: "file.txt", sha256: digest, bytes }],
  };
  const result = await planSourceUpdates(request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.assetMappings).toEqual([
    {
      from: name,
      to: generateAutomaticAssetName({
        projectNamespace: project.manifest.namespace,
        manifestRelativePath: path,
      }).value,
      path,
    },
  ]);
  expect(result.plan.candidate.tree.find((file) => file.path === path)!.bytes).toEqual(bytes);
  expect(
    decodeSource(result.plan.candidate.tree.find((file) => file.path === "blog/post.md")!.bytes),
  ).toContain(path.slice(5));
  const denied = await planSourceUpdates({
    ...request,
    media: [{ ...request.media[0], bytes: encodeSource("Changed") }],
  });
  expect(denied).toMatchObject({ ok: false, diagnostics: [{ code: "asset-bytes-mismatch" }] });
});
test("a Wiki page move preserves identity, incoming targets and untouched navigation comments", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/wiki\nsources: [{kind: wiki, config: docs/wiki.yaml}]\n",
      ),
      file(
        "docs/wiki.yaml",
        "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation:\n  - type: page\n    slug: start # keep route\n    source: pages/start\n  - type: page\n    slug: next # keep target route\n    source: pages/next\n",
      ),
      file("docs/pages/start.md", "---\nid: start\n---\n[Next](next.md?q=a%20b#heading)\n"),
      file("docs/pages/next.md", "---\nid: target\ncustom: exact\n---\n# Heading\n", "100755"),
    ],
  });
  const request = {
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: project.compilation.resources,
    operations: [
      { kind: "move" as const, resource: "WikiPage/target", path: "docs/pages/moved.md" },
    ],
    authority: { ...authority(project), create: ["docs/pages/moved.md"] },
  };
  const result = await planSourceUpdates(request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.candidate.tree.some((file) => file.path === "docs/pages/next.md")).toBe(false);
  expect(result.plan.candidate.tree.find((file) => file.path === "docs/pages/moved.md")!.mode).toBe(
    "100755",
  );
  const config = decodeSource(
    result.plan.candidate.tree.find((file) => file.path === "docs/wiki.yaml")!.bytes,
  );
  expect(config).toContain("slug: start # keep route\n    source: pages/start\n");
  expect(config).toContain('slug: next # keep target route\n    source: "pages/moved"\n');
  const start = result.plan.candidate.compilation.resources.find(
    (resource) => resource.type === "WikiPage" && resource.name === "start",
  ) as WikiPage;
  expect(start.spec.content.value).toContain("ref://wiki-page/target?q=a%20b#heading");
  expect(result.plan.derivedRepairs).toContainEqual({
    resource: "WikiPage/start",
    kind: "reference",
    position: "0/0",
    before: "next.md?q=a%20b#heading",
    after: "/next?q=a%20b#heading",
    target: "target",
  });
  const context = project.compilation.resources.find(
    (resource) => resource.type === "Wiki",
  ) as Wiki;
  const repeated = await planSourceUpdates({
    project: result.plan.candidate,
    expectedTreeDigest: result.plan.candidateTreeDigest,
    packageCohort: cohort,
    desiredResources: project.compilation.resources,
    operations: [],
    authority: authority(result.plan.candidate),
    referenceContexts: { "WikiPage/start": context, "WikiPage/target": context },
  });
  expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
  if (repeated.ok) expect(repeated.plan.changes).toEqual([]);
  const denied = await planSourceUpdates({
    ...request,
    authority: {
      ...request.authority,
      exclusive: request.authority.exclusive.filter((file) => file.path !== "docs/pages/start.md"),
    },
  });
  expect(denied).toMatchObject({
    ok: false,
    diagnostics: [{ code: "exclusive-authority-required", path: "docs/pages/start.md" }],
  });
});
test("Person edits preserve unselected records and configuration syntax", async () => {
  const project = await guideProject(
    "id: blog\ntitle: Blog\nsourceVersion: 1\npersons:\n  - id: alice\n    spec:\n      name: Alice # keep name\n      bio: old\n  - id: bob\n    spec: {name: Bob}\n  - id: carol\n    spec: {name: Carol} # untouched\ncustom: exact\n",
  );
  const desired = structuredClone(project.compilation.resources).filter(
    (resource) => resource.type !== "Person" || resource.name !== "bob",
  );
  const alice = desired.find(
    (resource) => resource.type === "Person" && resource.name === "alice",
  )!;
  if (alice.type !== "Person") return;
  alice.spec.bio = "New biography";
  alice.spec.email = "alice@example.com";
  desired.push({
    apiVersion: "v1",
    type: "Person",
    name: "dave",
    spec: { name: "Dave", email: null, bio: null },
  });
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [
      { kind: "update", resource: "Person/alice" },
      { kind: "delete", resource: "Person/bob" },
      { kind: "create", resource: "Person/dave", config: "blog/custom.yaml" },
    ],
    authority: {
      ...authority(project),
      resources: [...authority(project).resources, "Person/dave"],
    },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const config = decodeSource(result.plan.changes[0].candidate!.bytes);
  expect(config).toContain("name: Alice # keep name\n");
  expect(config).toContain("spec: {name: Carol} # untouched\n");
  expect(config).toContain("custom: exact\n");
  expect(result.plan.changes.map((change) => change.path)).toEqual(["blog/custom.yaml"]);
});
const file = (
  path: string,
  text: string,
  mode: SourceTreeFile["mode"] = "100644",
): SourceTreeFile => ({ path, bytes: encodeSource(text), mode });
async function guideProject(config = "id: blog\ntitle: Blog\nsourceVersion: 1\n") {
  return readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/writeback\nsources: [{kind: collection, config: blog/custom.yaml}]\n",
      ),
      file("blog/custom.yaml", config),
      file(
        "blog/post.md",
        "---\r\nid: stable-post\r\ntitle: Original # title comment\r\ncustom: untouched\r\n---\r\n# Original\r\n\r\nExact **body**.\r\n",
        "100755",
      ),
      file("README.md", "Unowned bytes\n"),
    ],
  });
}
function authority(project: SourceProject): SourceWriteAuthority {
  return {
    resources: project.compilation.resources.map((resource) => `${resource.type}/${resource.name}`),
    exclusive: project.documents
      .filter((doc) => /\.mdx?$/.test(doc.path))
      .map((doc) => ({ path: doc.path, sha256: doc.sha256, mode: doc.mode })),
    shared: project.configurations.filter((config) => config.path !== ".topik.yaml"),
    create: [],
  };
}

test("semantic no-op has no file changes and pins deterministic tree and plan digests", async () => {
  const project = await guideProject();
  const input = {
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: project.compilation.resources,
    operations: [],
    authority: authority(project),
  };
  const first = await planSourceUpdates(input);
  const second = await planSourceUpdates(input);
  expect(first.ok).toBe(true);
  expect(second).toEqual(first);
  if (!first.ok) return;
  expect(first.plan.changes).toEqual([]);
  expect(first.plan.candidateTreeDigest).toBe(project.treeDigest);
});

test("Guide metadata updates preserve the exact body, unknown frontmatter, comments, mode and unowned files", async () => {
  const project = await guideProject();
  const desired = structuredClone(project.compilation.resources);
  (desired.find((resource) => resource.type === "Guide") as Guide).spec.title = "Edited";
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Guide/stable-post" }],
    authority: authority(project),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.changes).toHaveLength(1);
  expect(result.plan.changes[0].candidate?.mode).toBe("100755");
  expect(decodeSource(result.plan.changes[0].candidate!.bytes)).toBe(
    '---\r\nid: stable-post\r\ntitle: "Edited" # title comment\r\ncustom: untouched\r\n---\r\n# Original\r\n\r\nExact **body**.\r\n',
  );
  expect(result.plan.candidate.tree.find((entry) => entry.path === "README.md")).toEqual(
    project.tree.find((entry) => entry.path === "README.md"),
  );
  const repeat = await planSourceUpdates({
    project: result.plan.candidate,
    expectedTreeDigest: result.plan.candidateTreeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [],
    authority: authority(result.plan.candidate),
  });
  expect(repeat.ok && repeat.plan.changes).toEqual([]);
});

test("Wiki config edits require independently admitted byte ranges and preserve root manifest and other fields", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/wiki\nsources: [{kind: wiki, config: docs/custom.json}]\n",
      ),
      file(
        "docs/custom.json",
        '{ "id": "docs", "title": "Original", "sourceVersion": 1, "navigation": ["intro"], "custom": [ 1, 2 ] }\n',
      ),
      file("docs/intro.md", "# Intro\n"),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  (desired.find((resource) => resource.type === "Wiki") as Wiki).spec.title = "Edited";
  const input = {
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update" as const, resource: "Wiki/docs" }],
    authority: authority(project),
  };
  const denied = await planSourceUpdates({
    ...input,
    authority: { ...input.authority, shared: [] },
  });
  expect(denied).toMatchObject({ ok: false, diagnostics: [{ code: "shared-authority-required" }] });
  const forged = structuredClone(input.authority);
  forged.shared[0].fields.find((field) => field.selector === "title")!.value!.end++;
  expect(await planSourceUpdates({ ...input, authority: forged })).toMatchObject({
    ok: false,
    diagnostics: [{ code: "shared-authority-stale" }],
  });
  const result = await planSourceUpdates(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.changes.map((change) => change.path)).toEqual(["docs/custom.json"]);
  expect(decodeSource(result.plan.changes[0].candidate!.bytes)).toContain('"custom": [ 1, 2 ]');
  expect(result.plan.changes[0].sharedEdits).toHaveLength(1);
});

test("reserved legacy fields block reviewed opt-in and stale trees never yield a partial plan", async () => {
  const project = await guideProject("id: blog\ntitle: Blog\n");
  expect(
    await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: project.compilation.resources,
      operations: [],
      authority: authority(project),
      optInConfigs: ["blog/custom.yaml"],
    }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "source-version-collision" }] });
  project.tree[0].bytes[0]++;
  expect(
    await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: project.compilation.resources,
      operations: [],
      authority: authority(project),
    }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "source-base-changed" }] });
});

test("editing one Wiki theme field preserves unknown theme entries and unchanged field comments", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/wiki\nsources: [{kind: wiki, config: wiki.yaml}]\n",
      ),
      file(
        "wiki.yaml",
        "id: docs\ntitle: Docs\nsourceVersion: 1\ntheme:\n  colors:\n    primary: '#ff0000'\n    dark: '#000000' # keep\n  custom: untouched\n",
      ),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  (desired.find((resource) => resource.type === "Wiki") as Wiki).spec.theme!.colors!.primary =
    "#00ff00";
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Wiki/docs" }],
    authority: authority(project),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(decodeSource(result.plan.changes[0].candidate!.bytes)).toBe(
    "id: docs\ntitle: Docs\nsourceVersion: 1\ntheme:\n  colors:\n    primary: \"#00ff00\"\n    dark: '#000000' # keep\n  custom: untouched\n",
  );
});

test("nested theme addition uses independently inspected insertion evidence", async () => {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/wiki\nsources: [{kind: wiki, config: wiki.yaml}]\n",
      ),
      file(
        "wiki.yaml",
        "id: docs\ntitle: Docs\nsourceVersion: 1\ntheme:\n  colors:\n    primary: '#ff0000' # keep\n",
      ),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  (desired.find((resource) => resource.type === "Wiki") as Wiki).spec.theme!.colors!.light =
    "#ffffff";
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Wiki/docs" }],
    authority: authority(project),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(decodeSource(result.plan.changes[0].candidate!.bytes)).toContain(
    "primary: '#ff0000' # keep\n    light: \"#ffffff\"\n",
  );
});
