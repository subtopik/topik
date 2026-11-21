import { expect, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import { generateAutomaticAssetName, parseAssetBlobUri } from "../assets/asset";
import type { Resource } from "../resource";
import {
  SourceTreeError,
  sourcePlanDiagnostics,
  sourcePlanDiagnosticCategory,
  type SourcePlanDiagnosticCode,
} from "./diagnostics";
import { initializeSourceProject } from "./initialize";
import { planSourceUpdates, type PlanSourceUpdatesInput } from "./plan";
import {
  initialSourceDocumentPath,
  newSourceDocumentPath,
  sourceDocumentPathCandidates,
  sourceMediaPath,
} from "./plan-markdown";
import {
  digestSourceTree,
  readSourceProject,
  snapshotSourceTree,
  SOURCE_PROJECT_LIMITS,
  type SourceProject,
} from "./project";
import { encodeSource, sourceHash } from "./syntax";

const cohort = "a".repeat(64);
const file = (path: string, raw: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(raw),
});
const tree = [
  file(
    ".topik.yaml",
    "version: 1\nnamespace: contract\nsources: [{kind: collection, config: docs/collection.yaml}]\n",
  ),
  file("docs/collection.yaml", "id: blog\ntitle: Blog\n"),
  file("docs/post.md", "---\nid: p\n---\n# Post\n"),
  // Occupies the path a new Guide with the slug `install` would get.
  file("docs/install.md", "---\nid: taken\nslug: taken\n---\n# Taken\n"),
];
const authority = (project: SourceProject, create: string[], resources: string[]) => ({
  resources: [
    ...project.compilation.resources.map((resource) => `${resource.type}/${resource.name}`),
    ...resources,
  ],
  exclusive: project.documents
    .filter((document) => /\.mdx?$/.test(document.path))
    .map(({ path, sha256, mode }) => ({ path, sha256, mode })),
  shared: project.configurations.filter((config) => config.path !== ".topik.yaml"),
  create,
});
const newGuide = (name: string, slug: string): Guide => ({
  apiVersion: "v1",
  type: "Guide",
  name,
  spec: { title: "Install", slug, content: { format: "topik", value: "# Install\n" } },
});

async function createInstallGuide(
  options: Pick<PlanSourceUpdatesInput, "pathCollisions">,
  create: string[],
) {
  const project = await readSourceProject({ tree });
  const guide = newGuide("install-guide", "install");
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: [...structuredClone(project.compilation.resources), guide],
    operations: [
      { kind: "create", resource: "Guide/install-guide", config: "docs/collection.yaml" },
    ],
    authority: authority(project, create, ["Guide/install-guide"]),
    ...options,
  });
  return { project, guide, result };
}

test("a derived document path that is occupied is renamed by default, as the exported rule says", async () => {
  const [plain, renamed] = sourceDocumentPathCandidates(
    "docs",
    newGuide("install-guide", "install"),
  );
  expect(plain).toBe("docs/install.md");
  expect(renamed).toBe(`docs/install-${sourceHash(encodeSource("install-guide")).slice(0, 8)}.md`);

  const { project, guide, result } = await createInstallGuide({}, [renamed]);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const created = result.plan.changes.filter((change) => change.kind === "create");
  expect(created.map((change) => change.path)).toEqual([renamed]);
  expect(
    newSourceDocumentPath({
      directory: "docs",
      resource: guide,
      occupied: project.tree.map((entry) => entry.path),
    }),
  ).toBe(renamed);

  // Naming the default explicitly changes neither the bytes nor the plan digest.
  const explicit = await createInstallGuide({ pathCollisions: "rename" }, [renamed]);
  expect(explicit.result.ok && explicit.result.plan.planDigest).toBe(result.plan.planDigest);
  expect(explicit.result.ok && explicit.result.plan.candidateTreeDigest).toBe(
    result.plan.candidateTreeDigest,
  );
});

test("pathCollisions: refuse reports the occupied path and writes nothing", async () => {
  const { project, guide, result } = await createInstallGuide({ pathCollisions: "refuse" }, [
    "docs/install.md",
  ]);
  expect(result).toEqual({
    ok: false,
    diagnostics: [
      {
        code: "source-path-collision",
        message: "A new Markdown path collides with the existing project.",
        resource: "Guide/install-guide",
        path: "docs/install.md",
      },
    ],
  });
  expect(
    newSourceDocumentPath({
      directory: "docs",
      resource: guide,
      occupied: project.tree.map((entry) => entry.path),
      pathCollisions: "refuse",
    }),
  ).toBeUndefined();
});

test("a free derived path is the plain one under either policy", async () => {
  for (const pathCollisions of [undefined, "rename", "refuse"] as const) {
    const project = await readSourceProject({ tree: tree.slice(0, 3) });
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: [
        ...structuredClone(project.compilation.resources),
        newGuide("install-guide", "install"),
      ],
      operations: [
        { kind: "create", resource: "Guide/install-guide", config: "docs/collection.yaml" },
      ],
      authority: authority(project, ["docs/install.md"], ["Guide/install-guide"]),
      pathCollisions,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok)
      expect(
        result.plan.changes.filter((change) => change.kind === "create").map(({ path }) => path),
      ).toEqual(["docs/install.md"]);
  }
});

test("new media is written to the path the exported rule gives", async () => {
  const project = await readSourceProject({ tree: tree.slice(0, 3) });
  const bytes = encodeSource("Download");
  const digest = sourceHash(bytes);
  const generated = generateAutomaticAssetName({
    projectNamespace: "hosted/example",
    manifestRelativePath: "manual.v2.txt",
  });
  if (!generated.ok) throw new Error("Invalid fixture asset");
  const name = generated.value;
  const path = sourceMediaPath({
    assetDirectory: project.compilation.provenance[0]!.assetDirectory,
    filename: "manual.v2.txt",
    name,
  });
  expect(path).toBe(`docs/_assets/manual.v2-${sourceHash(encodeSource(name)).slice(0, 8)}.txt`);

  const desired = structuredClone(project.compilation.resources) as Resource[];
  const post = desired.find((resource): resource is Guide => resource.type === "Guide")!;
  post.spec.content.value = `# Post\n\n[Manual](asset:${name})\n`;
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
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Guide/p" }],
    authority: authority(project, [path], []),
    media: [
      { config: "docs/collection.yaml", name, filename: "manual.v2.txt", sha256: digest, bytes },
    ],
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) expect(result.plan.assetMappings.map((mapping) => mapping.path)).toEqual([path]);
});

test("initialization renames the later of two Guides with one slug, or refuses", async () => {
  const input = {
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "contract",
      source: {
        kind: "collection" as const,
        config: "docs/collection.yaml",
        id: "blog",
        title: "Blog",
      },
    },
    resources: [newGuide("first", "same"), newGuide("second", "same")],
  };
  const renamed = sourceDocumentPathCandidates("docs", newGuide("second", "same"))[1];
  expect(renamed).toBe(`docs/same-${sourceHash(encodeSource("second")).slice(0, 8)}.md`);

  const byDefault = await initializeSourceProject({
    ...input,
    createPaths: [".topik.yaml", "docs/collection.yaml", "docs/same.md", renamed],
  });
  expect(byDefault.ok, JSON.stringify(byDefault)).toBe(true);
  if (byDefault.ok)
    expect(byDefault.plan.changes.map((change) => change.path)).toEqual(
      expect.arrayContaining(["docs/same.md", renamed]),
    );

  const refused = await initializeSourceProject({
    ...input,
    createPaths: [".topik.yaml", "docs/collection.yaml", "docs/same.md"],
    pathCollisions: "refuse",
  });
  expect(refused).toEqual({
    ok: false,
    diagnostics: [
      {
        code: "source-path-collision",
        message: "Two new Guides derive the same Markdown path.",
        resource: "Guide/second",
        path: "docs/same.md",
      },
    ],
  });
});

test("initialization derives the documented paths for each kind and never renames an explicit one", async () => {
  expect(initialSourceDocumentPath({ kind: "collection", directory: "docs", slug: "hello" })).toBe(
    "docs/hello.md",
  );
  expect(
    initialSourceDocumentPath({ kind: "wiki", directory: "", sourcePath: "guides/setup" }),
  ).toBe("guides/setup.md");
  expect(
    initialSourceDocumentPath({
      kind: "course",
      directory: "course",
      moduleSlug: "basics",
      slug: "one",
    }),
  ).toBe("course/basics/one.md");

  const guide = newGuide("first", "hello");
  const bytes = encodeSource("Download");
  const digest = sourceHash(bytes);
  const generated = generateAutomaticAssetName({
    projectNamespace: "hosted/example",
    manifestRelativePath: "manual.txt",
  });
  if (!generated.ok) throw new Error("Invalid fixture asset");
  guide.spec.content.value = `# Install\n\n[Manual](asset:${generated.value})\n`;
  const documentPath = initialSourceDocumentPath({
    kind: "collection",
    directory: "docs",
    slug: guide.spec.slug,
  });
  const mediaPath = sourceMediaPath({
    assetDirectory: "docs/_assets",
    filename: "manual.txt",
    name: generated.value,
  });
  const input = {
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "contract",
      source: {
        kind: "collection" as const,
        config: "docs/collection.yaml",
        id: "blog",
        title: "Blog",
      },
    },
    resources: [
      guide,
      {
        apiVersion: "v1" as const,
        type: "Asset" as const,
        name: generated.value,
        spec: {
          uri: parseAssetBlobUri(`blobs/${digest}`),
          integrity: `sha256:${digest}` as const,
          size: bytes.length,
          mediaType: "application/octet-stream",
        },
      },
    ],
    media: [{ name: generated.value, filename: "manual.txt", sha256: digest, bytes }],
  };
  const result = await initializeSourceProject({
    ...input,
    createPaths: [".topik.yaml", "docs/collection.yaml", documentPath, mediaPath],
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok)
    expect(result.plan.changes.map((change) => change.path).sort()).toEqual(
      [".topik.yaml", "docs/collection.yaml", documentPath, mediaPath].sort(),
    );

  // An explicit document path that is occupied fails; it is never renamed.
  const occupied = file("docs/taken.md", "# Taken\n");
  const explicit = await initializeSourceProject({
    ...input,
    tree: [occupied],
    expectedTreeDigest: digestSourceTree([occupied]),
    documentPaths: { "Guide/first": "docs/taken.md" },
    createPaths: [".topik.yaml", "docs/collection.yaml", "docs/taken.md", mediaPath],
  });
  expect(explicit.ok).toBe(false);
  if (!explicit.ok)
    expect(
      explicit.diagnostics.map((diagnostic) => sourcePlanDiagnosticCategory(diagnostic)),
    ).toEqual(["path"]);
});

test("an unexpected exception is internal, whatever code its fallback carries", () => {
  const fallback = {
    code: "source-validation-failed",
    message: "Source planning could not complete.",
  };
  const [unexpected] = sourcePlanDiagnostics(new Error("private runtime detail"), fallback);
  expect(unexpected).toEqual(fallback);
  expect(sourcePlanDiagnosticCategory(unexpected!)).toBe("internal");
  for (const thrown of [undefined, null, "text", 0])
    expect(sourcePlanDiagnosticCategory(sourcePlanDiagnostics(thrown, fallback)[0]!)).toBe(
      "internal",
    );
  // The marker is not enumerable: a copy or a bare code reads as an ordinary validation failure.
  expect(sourcePlanDiagnosticCategory({ ...unexpected! })).toBe("validation");
  expect(sourcePlanDiagnosticCategory(unexpected!.code)).toBe("validation");
});

test("reading a project throws for an oversized tree; the planners return the diagnostic", async () => {
  const one = file("a.md", "# A\n");
  const tooMany = Array.from({ length: SOURCE_PROJECT_LIMITS.maxFiles + 1 }, (_, index) => ({
    ...one,
    path: `f${index}.md`,
  }));
  await expect(readSourceProject({ tree: tooMany })).rejects.toMatchObject({
    name: "SourceTreeError",
    diagnostic: { code: "source-tree-too-large", limit: 10_000, count: 10_001, unit: "files" },
  });
});

test("a tree over a limit reports which limit and by how much", async () => {
  const one = file("a.md", "# A\n");
  const tooMany = Array.from({ length: SOURCE_PROJECT_LIMITS.maxFiles + 1 }, (_, index) => ({
    ...one,
    path: `f${index}.md`,
  }));
  let thrown: unknown;
  try {
    snapshotSourceTree(tooMany);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SourceTreeError);
  expect((thrown as SourceTreeError).diagnostic).toEqual({
    code: "source-tree-too-large",
    message: "Source tree exceeds file limit",
    limit: 10_000,
    count: 10_001,
    unit: "files",
  });

  const result = await initializeSourceProject({
    tree: tooMany,
    expectedTreeDigest: "0".repeat(64),
    packageCohort: cohort,
    intent: {
      namespace: "contract",
      source: { kind: "collection", config: "docs/collection.yaml", id: "blog", title: "Blog" },
    },
    resources: [],
    createPaths: [],
  });
  expect(result).toMatchObject({
    ok: false,
    diagnostics: [{ code: "source-tree-too-large", limit: 10_000, count: 10_001, unit: "files" }],
  });

  // A tree that is invalid for another reason keeps the general code and no size.
  expect(() => snapshotSourceTree([one, one])).toThrow(
    expect.objectContaining({
      diagnostic: expect.objectContaining({ code: "source-tree-invalid" }),
    }),
  );
});

test("every planner code has a category, and compiler IDs follow the stated rule", () => {
  const expected: Partial<Record<SourcePlanDiagnosticCode, string>> = {
    "source-mapping-missing": "mapping",
    "shared-authority-required": "authority",
    "shared-authority-stale": "authority",
    "create-authority-required": "authority",
    "resource-scope-denied": "scope",
    "shared-reference-scope-denied": "scope",
    "reference-target-removed": "reference",
    "reference-unrepresentable": "unrepresentable",
    "source-validation-failed": "validation",
    "source-writer-incompatible": "incompatible",
    "source-base-changed": "stale",
    "source-path-collision": "path",
    "source-tree-too-large": "tree",
    "asset-bytes-mismatch": "asset",
    "operation-required": "request",
  };
  for (const [code, category] of Object.entries(expected))
    expect(sourcePlanDiagnosticCategory(code)).toBe(category);
  expect(sourcePlanDiagnosticCategory("link-fragment-not-found")).toBe("reference");
  expect(sourcePlanDiagnosticCategory("config-invalid")).toBe("validation");
  expect(sourcePlanDiagnosticCategory("node-undefined")).toBe("validation");
  expect(sourcePlanDiagnosticCategory("toString")).toBe("validation");
});
