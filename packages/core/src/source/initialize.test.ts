import { expect, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import type { Wiki } from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import { initializeSourceProject, addSourceToProject } from "./initialize";
import { digestSourceTree, readSourceProject, type SourceTreeFile } from "./project";
import { encodeSource, decodeSource } from "./syntax";
import type { Resource } from "../resource";

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

test("adding sources resolves authored cross-kind links and retains saved local route meaning", async () => {
  const project = await readSourceProject({
    tree: [
      {
        path: ".topik.yaml",
        mode: "100644",
        bytes: encodeSource(
          "version: 1\nnamespace: refs\nsources:\n  - {kind: collection, config: guides/collection.yaml}\n",
        ),
      },
      {
        path: "guides/collection.yaml",
        mode: "100644",
        bytes: encodeSource("sourceVersion: 1\nid: guides\ntitle: Guides\n"),
      },
      {
        path: "guides/install.md",
        mode: "100644",
        bytes: encodeSource("---\nid: install-md\nslug: install-md\n---\n# Setup\n"),
      },
      {
        path: "guides/install.mdx",
        mode: "100644",
        bytes: encodeSource("---\nid: install-mdx\nslug: install-mdx\n---\n# Other\n"),
      },
    ],
  });
  const saved: Wiki = {
    apiVersion: "v1",
    type: "Wiki",
    name: "docs",
    spec: {
      title: "Docs",
      sourceVersion: 1,
      navigation: [
        { type: "page", page: "home", slug: "home", sourcePath: "old/home" },
        { type: "page", page: "target", slug: "old-target", sourcePath: "old/target" },
      ],
    },
  };
  const wiki = structuredClone(saved);
  wiki.spec.navigation = [
    { type: "page", page: "home", slug: "home", sourcePath: "pages/nested/home" },
    { type: "page", page: "target", slug: "new-target", sourcePath: "relocated/target" },
  ];
  const pages: WikiPage[] = [
    {
      apiVersion: "v1",
      type: "WikiPage",
      name: "home",
      spec: {
        wiki: "docs",
        title: "Home",
        content: {
          format: "topik",
          value:
            "# Home\n\n[Local](./target.md#local)\n\n[Install](../../guides/install.md#setup)\n",
        },
      },
    },
    {
      apiVersion: "v1",
      type: "WikiPage",
      name: "target",
      spec: { wiki: "docs", title: "Local", content: { format: "topik", value: "# Local\n" } },
    },
  ];
  const manifest = project.configurations.find((config) => config.path === ".topik.yaml")!;
  const result = await addSourceToProject({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    source: { kind: "wiki", config: "docs/wiki.yaml", id: "docs", title: "Docs" },
    resources: [wiki, ...pages],
    referenceContexts: { "WikiPage/home": saved, "WikiPage/target": saved },
    createPaths: ["docs/wiki.yaml", "docs/pages/nested/home.md", "docs/relocated/target.md"],
    manifestAuthority: {
      ...manifest,
      fields: manifest.fields.filter((field) => field.selector === "sources/+"),
    },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const home = result.plan.candidate.compilation.resources.find(
    (resource): resource is WikiPage => resource.type === "WikiPage" && resource.name === "home",
  )!;
  expect(home.spec.content.value).toContain("ref://guide/install-md#setup");
  expect(home.spec.content.value).toContain("ref://wiki-page/target#local");
  const authored = decodeSource(
    result.plan.candidate.tree.find((entry) => entry.path === "docs/pages/nested/home.md")!.bytes,
  );
  expect(authored).toContain("[Install](../../../guides/install.md#setup)");
  expect(authored).toContain("[Local](/new-target#local)");
  const withWiki = result.plan.candidate;
  const courseResources: Resource[] = [
    {
      apiVersion: "v1",
      type: "Course",
      name: "lessons",
      spec: { title: "Lessons", slug: "lessons" },
    },
    {
      apiVersion: "v1",
      type: "CourseModule",
      name: "basics",
      spec: { course: "lessons", title: "Basics", slug: "basics", order: 0 },
    },
    {
      apiVersion: "v1",
      type: "CoursePage",
      name: "intro",
      spec: {
        module: "basics",
        title: "Intro",
        slug: "intro",
        order: 0,
        content: {
          format: "topik",
          value:
            "# Intro\n\n[Guide](../guides/install.md#setup)\n\n[Home](../docs/pages/nested/home.md#home)\n",
        },
      },
    },
  ];
  const nextManifest = withWiki.configurations.find((config) => config.path === ".topik.yaml")!;
  const courseResult = await addSourceToProject({
    project: withWiki,
    expectedTreeDigest: withWiki.treeDigest,
    packageCohort: cohort,
    source: { kind: "course", config: "lessons/course.yaml", id: "lessons", title: "Lessons" },
    resources: courseResources,
    documentPaths: { "CoursePage/intro": "lessons/intro.md" },
    createPaths: ["lessons/course.yaml", "lessons/intro.md"],
    manifestAuthority: {
      ...nextManifest,
      fields: nextManifest.fields.filter((field) => field.selector === "sources/+"),
    },
  });
  expect(courseResult.ok, JSON.stringify(courseResult)).toBe(true);
  if (!courseResult.ok) return;
  const intro = courseResult.plan.candidate.compilation.resources.find(
    (resource) => resource.type === "CoursePage",
  )!;
  if (intro.type !== "CoursePage") throw new Error("Expected a Course page");
  expect(intro.spec.content.value).toContain("ref://guide/install-md#setup");
  expect(intro.spec.content.value).toContain("ref://wiki-page/home#home");
  expect(
    decodeSource(
      courseResult.plan.candidate.tree.find((entry) => entry.path === "lessons/intro.md")!.bytes,
    ),
  ).toContain("[Home](../docs/pages/nested/home.md#home)");
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
  expect(candidatePage.spec.content.value).toContain(
    "ref://wiki-page/route-target?x=a%20b#heading",
  );
});
