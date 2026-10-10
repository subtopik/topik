import { expect, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import type { Wiki } from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import { initializeSourceProject, addSourceToProject } from "./initialize";
import { digestSourceTree, readSourceProject, type SourceTreeFile } from "./project";
import { encodeSource, decodeSource } from "./syntax";

const cohort = "a".repeat(64);
test("explicit admitted Guide paths preserve the public slug and refuse ungranted destinations", async () => {
  const guide: Guide = {
    apiVersion: "v1",
    type: "Guide",
    name: "portable-guide",
    spec: { title: "CON", slug: "con", content: { format: "topik", value: "# Content\n" } },
  };
  const request = {
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "examples/paths",
      source: {
        kind: "collection" as const,
        config: "guides/collection.yaml",
        id: "guides",
        title: "Guides",
      },
    },
    resources: [guide],
    documentPaths: { "Guide/portable-guide": "guides/con-readable.md" },
    createPaths: [".topik.yaml", "guides/collection.yaml", "guides/con-readable.md"],
  };
  const result = await initializeSourceProject(request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.candidate.compilation.resources).toContainEqual(guide);
  expect(
    result.plan.candidate.documents.find((document) => document.resource === "Guide/portable-guide")
      ?.path,
  ).toBe("guides/con-readable.md");
  expect(
    await initializeSourceProject({
      ...request,
      documentPaths: { "Guide/portable-guide": "guides/ungranted.md" },
    }),
  ).toMatchObject({ ok: false });
});
test("initialization preserves saved link identities after routes and source paths change", async () => {
  const saved: Wiki = {
    apiVersion: "v1",
    type: "Wiki",
    name: "docs",
    spec: {
      title: "Docs",
      sourceVersion: 1,
      navigation: [
        { type: "page", page: "home", slug: "home", sourcePath: "old/index" },
        { type: "page", page: "target", slug: "old-route", sourcePath: "old/target" },
      ],
    },
  };
  const current = structuredClone(saved);
  current.spec.navigation![0] = {
    type: "page",
    page: "home",
    slug: "home",
    sourcePath: "new/index",
  };
  current.spec.navigation![1] = {
    type: "page",
    page: "target",
    slug: "new-route",
    sourcePath: "relocated/target",
  };
  const pages: WikiPage[] = ["home", "target"].map((name) => ({
    apiVersion: "v1",
    type: "WikiPage",
    name,
    spec: {
      wiki: "docs",
      title: name,
      content: {
        format: "topik",
        value: name === "home" ? "[Go](./target.md?x=1#heading)\n" : "# Heading\n",
      },
    },
  }));
  const request = {
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "examples/saved",
      source: { kind: "wiki" as const, config: "docs/wiki.yaml", id: "docs", title: "Docs" },
    },
    resources: [current, ...pages],
    referenceContexts: { "WikiPage/home": saved, "WikiPage/target": saved },
    createPaths: [".topik.yaml", "docs/wiki.yaml", "docs/new/index.md", "docs/relocated/target.md"],
  };
  const result = await initializeSourceProject(request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.derivedRepairs).toContainEqual(
    expect.objectContaining({
      resource: "WikiPage/home",
      target: "target",
      after: "/new-route?x=1#heading",
    }),
  );
  expect(
    decodeSource(
      result.plan.candidate.tree.find((file) => file.path === "docs/new/index.md")!.bytes,
    ),
  ).toContain("/new-route?x=1#heading");
  const foreign = { ...saved, name: "another" };
  expect(
    await initializeSourceProject({ ...request, referenceContexts: { "WikiPage/home": foreign } }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "reference-context-invalid" }] });
});
test.each(["", "\uFEFF"])("source addition retains root bytes with prefix %j", async (prefix) => {
  const root =
    prefix +
    "# owned root\nnamespace: 'examples/existing' # keep\nversion: 1\nsources:\n  - kind: wiki # keep source\n    config: docs/wiki.yaml\n";
  const project = await readSourceProject({
    tree: [
      ...occupied,
      { path: ".topik.yaml", mode: "100644", bytes: encodeSource(root) },
      { path: "docs/wiki.yaml", mode: "100644", bytes: encodeSource("id: docs\ntitle: Docs\n") },
    ],
  });
  const manifest = project.configurations.find((config) => config.path === ".topik.yaml")!;
  const request = {
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    source: intent.source,
    resources: [guide],
    createPaths: ["content/custom.yml", "content/guide.md"],
    manifestAuthority: {
      ...manifest,
      fields: manifest.fields.filter((field) => field.selector === "sources/+"),
    },
  };
  const result = await addSourceToProject(request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const changedRoot = result.plan.changes.find((change) => change.path === ".topik.yaml")!;
  expect(changedRoot.kind).toBe("update");
  expect(changedRoot.candidate!.mode).toBe("100644");
  expect(changedRoot.candidate!.bytes).toEqual(
    encodeSource(`${root}  - {"kind":"collection","config":"content/custom.yml"}\n`),
  );
  expect(result.plan.candidate.compilation.resources).toContainEqual(guide);
  expect(result.plan.candidate.manifest.namespace).toBe("examples/existing");
  const denied = await addSourceToProject({
    ...request,
    manifestAuthority: {
      ...manifest,
      fields: manifest.fields.filter((field) => field.selector === "namespace"),
    },
  });
  expect(denied.ok).toBe(false);
});
const guide: Guide = {
  apiVersion: "v1",
  type: "Guide",
  name: "stable-guide",
  labels: {},
  spec: {
    title: "Guide",
    slug: "guide",
    description: null,
    tags: [],
    authors: [],
    content: { format: "topik", value: "# Guide\n" },
  },
};
const occupied: SourceTreeFile[] = [
  { path: "README.md", mode: "100755", bytes: encodeSource("Leave exact\r\n") },
  { path: "colors.json", mode: "100644", bytes: encodeSource('["red", "blue"]\n') },
  { path: "data.yaml", mode: "100644", bytes: encodeSource("- red\n- blue\n") },
];
const intent = {
  namespace: "examples/created",
  source: { kind: "collection" as const, config: "content/custom.yml", id: "blog", title: "Blog" },
};

test("explicit Guide initialization returns a complete deterministic source project without adopting unrelated files", async () => {
  const input = {
    tree: occupied,
    expectedTreeDigest: digestSourceTree(occupied),
    packageCohort: cohort,
    intent,
    resources: [guide],
    createPaths: [".topik.yaml", "content/custom.yml", "content/guide.md"],
  };
  const first = await initializeSourceProject(input);
  expect(first.ok).toBe(true);
  expect(await initializeSourceProject(input)).toEqual(first);
  if (!first.ok) return;
  expect(first.plan.changes.map((change) => change.path)).toEqual([
    ".topik.yaml",
    "content/custom.yml",
    "content/guide.md",
  ]);
  expect(first.plan.candidate.compilation.resources).toEqual([guide]);
  expect(first.plan.candidate.tree.find((file) => file.path === "README.md")).toEqual(occupied[0]);
  expect(
    decodeSource(
      first.plan.candidate.tree.find((file) => file.path === "content/custom.yml")!.bytes,
    ),
  ).toContain("sourceVersion: 1\n");
});

test("existing empty/invalid projects, source configurations and path collisions block initialization", async () => {
  const request = {
    expectedTreeDigest: digestSourceTree(occupied),
    packageCohort: cohort,
    intent,
    resources: [guide],
    createPaths: [".topik.yaml", "content/custom.yml", "content/guide.md"],
  };
  for (const existing of [
    { path: ".topik.yaml", bytes: encodeSource("version: 1\nnamespace: existing\nsources: []\n") },
    { path: ".topik.yaml", bytes: encodeSource("invalid") },
    { path: "old/custom.yaml", bytes: encodeSource("id: existing\ntitle: Existing\n") },
    { path: "content/guide.md", bytes: encodeSource("Occupied\n") },
  ]) {
    const tree = [...occupied, { ...existing, mode: "100644" as const }];
    const result = await initializeSourceProject({
      ...request,
      tree,
      expectedTreeDigest: digestSourceTree(tree),
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("plan");
  }
});

test("new Wiki source/route context compiles from its files alone with stable IDs and hidden routes", async () => {
  const wiki: Wiki = {
    apiVersion: "v1",
    type: "Wiki",
    name: "docs",
    spec: {
      title: "Docs",
      navigation: [
        {
          type: "page",
          page: "intro-page",
          slug: "intro",
          sourcePath: "pages/start",
          hidden: true,
        },
      ],
    },
  };
  const page: WikiPage = {
    apiVersion: "v1",
    type: "WikiPage",
    name: "intro-page",
    spec: { wiki: "docs", title: "Intro", content: { format: "topik", value: "# Intro\n" } },
  };
  const result = await initializeSourceProject({
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "examples/wiki",
      source: { kind: "wiki", config: "docs/custom.json", id: "docs", title: "Docs" },
    },
    resources: [wiki, page],
    createPaths: [".topik.yaml", "docs/custom.json", "docs/pages/start.md"],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    result.plan.candidate.compilation.resources.find((resource) => resource.type === "Wiki"),
  ).toMatchObject({
    spec: {
      sourceVersion: 1,
      navigation: [{ page: "intro-page", sourcePath: "pages/start", slug: "intro", hidden: true }],
    },
  });
});

test("escaped configuration keys still block new-project initialization", async () => {
  const tree = [
    ...occupied,
    {
      path: "old/custom.yaml",
      mode: "100644" as const,
      bytes: encodeSource('"\\u0069d": existing\n"\\u0074itle": Existing\n'),
    },
  ];
  expect(
    await initializeSourceProject({
      tree,
      expectedTreeDigest: digestSourceTree(tree),
      packageCohort: cohort,
      intent,
      resources: [guide],
      createPaths: [".topik.yaml", "content/custom.yml", "content/guide.md"],
    }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "initialization-unproven" }] });
});

test("Wiki initialization preserves resolved targets when enabling source link semantics", async () => {
  const wiki: Wiki = {
    apiVersion: "v1",
    type: "Wiki",
    name: "docs",
    spec: {
      title: "Docs",
      navigation: [
        { type: "page", page: "start", slug: "start", sourcePath: "pages/start" },
        { type: "page", page: "source-target", slug: "other-route", sourcePath: "pages/next" },
        { type: "page", page: "route-target", slug: "pages/next", sourcePath: "other/file" },
      ],
    },
  };
  const pages: WikiPage[] = ["start", "source-target", "route-target"].map((name) => ({
    apiVersion: "v1",
    type: "WikiPage",
    name,
    spec: {
      wiki: "docs",
      title: name,
      content: {
        format: "topik",
        value: name === "start" ? "[Target](next?x=a%20b#heading)\n" : "# Heading\n",
      },
    },
  }));
  const result = await initializeSourceProject({
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "examples/wiki",
      source: { kind: "wiki", config: "wiki.yaml", id: "docs", title: "Docs" },
    },
    resources: [wiki, ...pages],
    createPaths: [".topik.yaml", "wiki.yaml", "pages/start.md", "pages/next.md", "other/file.md"],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const candidatePage = result.plan.candidate.compilation.resources.find(
    (resource) => resource.type === "WikiPage" && resource.name === "start",
  ) as WikiPage;
  expect(candidatePage.spec.content.value).toContain("/pages/next?x=a%20b#heading");
});
