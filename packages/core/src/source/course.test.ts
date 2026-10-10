import { expect, test } from "vite-plus/test";
import type { Course } from "@topik/schema/course/v1";
import type { CourseModule } from "@topik/schema/course-module/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import type { Resource } from "../resource";
import { generateAutomaticAssetName, parseAssetBlobUri } from "../assets/asset";
import { initializeSourceProject, addSourceToProject } from "./initialize";
import { planSourceUpdates, type SourceWriteAuthority, type SourceResourceOperation } from "./plan";
import {
  readSourceProject,
  digestSourceTree,
  type SourceProject,
  type SourceTreeFile,
} from "./project";
import { encodeSource, decodeSource, sourceHash } from "./syntax";

const cohort = "a".repeat(64);
const file = (path: string, text: string): SourceTreeFile => ({
  path,
  mode: "100644",
  bytes: encodeSource(text),
});
const rawConfig = `# Course configuration\nsourceVersion: 1\nid: fundamentals\ntitle: Fundamentals # retain\nslug: fundamentals\ndescription: null\nlabels: { audience: beginner }\nauthors: [alice]\npersons:\n  - id: alice\n    labels: { role: author }\n    spec: { name: Alice, email: alice@example.test, bio: "A teacher" }\nmodules:\n  - id: basics\n    title: Basics # retain module comment\n    slug: basics\n    order: 0\n    description: null\n    labels: { level: introductory }\n    pages:\n      - pages/intro # retain membership comment\n      - pages/target\n    customModule: retain\n  - id: advanced\n    title: Advanced\n    slug: advanced\n    order: 7\n    pages: []\n    customModule: exact\ncustom: { exact: unchanged }\n`;

async function courseProject(): Promise<SourceProject> {
  return readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/course\nsources: [{kind: course, config: lessons/course.yaml}]\n",
      ),
      file("lessons/course.yaml", rawConfig),
      file(
        "lessons/pages/intro.md",
        "---\nid: intro\ntitle: Intro\nslug: start\norder: 2\nauthors: [alice]\nlabels: { edition: first }\ncustom: unchanged\n---\n# Intro\n\n[Details](./target.md?view=full#details)\n",
      ),
      file(
        "lessons/pages/target.md",
        "---\nid: target\ntitle: Target\nslug: destination\norder: 5\n---\n# Target\n\n## Details\n",
      ),
      file("README.txt", "untouched\n"),
    ],
  });
}
function authority(project: SourceProject): SourceWriteAuthority {
  return {
    resources: project.compilation.resources.map((resource) => `${resource.type}/${resource.name}`),
    exclusive: project.documents
      .filter((document) => document.path !== document.config)
      .map((document) => ({ path: document.path, sha256: document.sha256, mode: document.mode })),
    shared: project.configurations.map((config) => ({ ...config, fields: config.fields })),
    create: [],
  };
}
function resource<T extends Resource["type"]>(
  resources: Resource[],
  type: T,
  name?: string,
): Extract<Resource, { type: T }> {
  return resources.find(
    (resource) => resource.type === type && (name === undefined || resource.name === name),
  ) as Extract<Resource, { type: T }>;
}
const rawFile = (project: SourceProject, path: string): string =>
  decodeSource(project.tree.find((file) => file.path === path)!.bytes);
async function plan(
  project: SourceProject,
  desired: Resource[],
  operations: SourceResourceOperation[],
  extra: Partial<Parameters<typeof planSourceUpdates>[0]> = {},
) {
  return planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations,
    authority: authority(project),
    ...extra,
  });
}

test("Course inspection retains metadata, memberships, reference context and unchanged source bytes", async () => {
  const project = await courseProject();
  expect(resource(project.compilation.resources, "Course")).toMatchObject({
    labels: { audience: "beginner" },
    spec: { slug: "fundamentals", description: null, authors: ["alice"] },
  });
  expect(resource(project.compilation.resources, "CourseModule", "basics")).toMatchObject({
    labels: { level: "introductory" },
    spec: { course: "fundamentals", order: 0, description: null },
  });
  const page = project.documents.find((document) => document.resource === "CoursePage/intro")!;
  expect(page.sourceContext).toMatchObject({
    course: "Course/fundamentals",
    path: "pages/intro.md",
  });
  expect(page.references).toMatchObject([
    { target: "CoursePage/target", search: "?view=full", hash: "details" },
  ]);
  expect(page.fieldOrigins).toContainEqual(
    expect.objectContaining({
      field: "spec/module",
      origin: "inherited",
      selector: "modules/basics/pages/pages%2Fintro",
    }),
  );
  expect(project.courseContexts["Course/fundamentals"].pages).toContainEqual({
    name: "intro",
    module: "basics",
    slug: "start",
    sourcePath: "pages/intro",
  });
  const result = await plan(project, project.compilation.resources, []);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) {
    expect(result.plan.changes).toEqual([]);
    expect(result.plan.candidate.treeDigest).toBe(project.treeDigest);
  }
});

test("narrow Course and module metadata edits preserve sibling entries, comments and explicit sequence order", async () => {
  const project = await courseProject();
  const desired = structuredClone(project.compilation.resources);
  resource(desired, "Course").spec.title = "Edited fundamentals";
  resource(desired, "CourseModule", "basics").spec.order = 10;
  resource(desired, "CourseModule", "basics").spec.description = "New module description";
  const config = project.configurations.find((config) => config.path === "lessons/course.yaml")!;
  const scope = authority(project);
  scope.shared = [
    {
      ...config,
      fields: config.fields.filter((field) =>
        ["title", "modules/basics/order", "modules/basics/description"].includes(field.selector),
      ),
    },
  ];
  const result = await plan(
    project,
    desired,
    [
      { kind: "update", resource: "Course/fundamentals" },
      { kind: "update", resource: "CourseModule/basics" },
    ],
    { authority: scope },
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.changes.map((change) => change.path)).toEqual(["lessons/course.yaml"]);
  expect(rawFile(result.plan.candidate, "lessons/course.yaml")).toBe(
    rawConfig
      .replace("title: Fundamentals", 'title: "Edited fundamentals"')
      .replace("order: 0", "order: 10")
      .replace("    description: null", '    description: "New module description"'),
  );
  expect(result.plan.changes[0].sharedEdits?.map((edit) => edit.selector).sort()).toEqual([
    "modules/basics/description",
    "modules/basics/order",
    "title",
  ]);
  expect(
    await plan(
      project,
      desired,
      [
        { kind: "update", resource: "Course/fundamentals" },
        { kind: "update", resource: "CourseModule/basics" },
      ],
      {
        authority: {
          ...scope,
          shared: [
            { ...config, fields: config.fields.filter((field) => field.selector === "title") },
          ],
        },
      },
    ),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "shared-scope-denied" }] });
});

test("changing a Course page module preserves link meaning and updates membership without implicitly moving source files", async () => {
  const project = await courseProject();
  const desired = structuredClone(project.compilation.resources);
  resource(desired, "CoursePage", "target").spec.module = "advanced";
  const result = await plan(project, desired, [{ kind: "update", resource: "CoursePage/target" }]);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(
    result.plan.candidate.documents.find((document) => document.resource === "CoursePage/target")
      ?.path,
  ).toBe("lessons/pages/target.md");
  expect(rawFile(result.plan.candidate, "lessons/pages/target.md")).toBe(
    rawFile(project, "lessons/pages/target.md"),
  );
  expect(rawFile(result.plan.candidate, "lessons/course.yaml")).toContain(
    "pages/intro # retain membership comment",
  );
  expect(
    result.plan.candidate.courseContexts["Course/fundamentals"].pages.find(
      (page) => page.name === "target",
    )?.module,
  ).toBe("advanced");
  const denied = {
    ...authority(project),
    resources: authority(project).resources.filter((key) => key !== "CourseModule/advanced"),
  };
  expect(
    await plan(project, desired, [{ kind: "update", resource: "CoursePage/target" }], {
      authority: denied,
    }),
  ).toMatchObject({
    ok: false,
    diagnostics: [{ code: "resource-scope-denied", resource: "CourseModule/advanced" }],
  });
});

test("an acknowledged module reassignment retains the original saved Course context for later no-op plans and edits", async () => {
  const project = await courseProject();
  const saved = project.courseContexts["Course/fundamentals"];
  const desired = structuredClone(project.compilation.resources);
  resource(desired, "CoursePage", "intro").spec.module = "advanced";
  const courseReferenceContexts = { "CoursePage/intro": saved };
  const moved = await plan(project, desired, [{ kind: "update", resource: "CoursePage/intro" }], {
    courseReferenceContexts,
  });
  expect(moved.ok, JSON.stringify(moved)).toBe(true);
  if (!moved.ok) return;
  const acknowledged = moved.plan.candidate;
  const unchanged = await plan(acknowledged, acknowledged.compilation.resources, [], {
    courseReferenceContexts,
  });
  expect(unchanged.ok, JSON.stringify(unchanged)).toBe(true);
  if (unchanged.ok) expect(unchanged.plan.changes).toEqual([]);
  const edited = structuredClone(acknowledged.compilation.resources);
  resource(edited, "CoursePage", "intro").spec.content.value += "\nSaved after reassignment.\n";
  const updated = await plan(
    acknowledged,
    edited,
    [{ kind: "update", resource: "CoursePage/intro" }],
    { courseReferenceContexts },
  );
  expect(updated.ok, JSON.stringify(updated)).toBe(true);
  if (updated.ok) {
    expect(
      resource(updated.plan.candidate.compilation.resources, "CoursePage", "intro").spec,
    ).toMatchObject({
      module: "advanced",
      content: { value: expect.stringContaining("Saved after reassignment.") },
    });
    expect(
      updated.plan.candidate.documents.find((document) => document.resource === "CoursePage/intro")
        ?.references,
    ).toMatchObject([{ target: "CoursePage/target", search: "?view=full", hash: "details" }]);
  }
});

test("an explicit Course page source move retains stable identity, slug, mode and saved link destinations", async () => {
  const original = await courseProject();
  const project = await readSourceProject({
    tree: original.tree.map((file) =>
      file.path === "lessons/pages/target.md" ? { ...file, mode: "100755" } : file,
    ),
  });
  const result = await plan(
    project,
    project.compilation.resources,
    [{ kind: "move", resource: "CoursePage/target", path: "lessons/moved/content.md" }],
    { authority: { ...authority(project), create: ["lessons/moved/content.md"] } },
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.candidate.tree.some((file) => file.path === "lessons/pages/target.md")).toBe(
    false,
  );
  expect(
    result.plan.candidate.tree.find((file) => file.path === "lessons/moved/content.md")?.mode,
  ).toBe("100755");
  expect(
    resource(result.plan.candidate.compilation.resources, "CoursePage", "target").spec,
  ).toMatchObject({ slug: "destination", module: "basics", order: 5 });
  expect(rawFile(result.plan.candidate, "lessons/pages/intro.md")).toContain(
    "/basics/destination?view=full#details",
  );
  expect(result.plan.derivedRepairs).toContainEqual(
    expect.objectContaining({ resource: "CoursePage/intro", kind: "reference", target: "target" }),
  );
});

test("Course module and page creation and deletion preserve unrelated bytes and refuse surviving orphan pages", async () => {
  const project = await courseProject();
  const module: CourseModule = {
    apiVersion: "v1",
    type: "CourseModule",
    name: "practice",
    labels: { kind: "exercise" },
    spec: {
      course: "fundamentals",
      title: "Practice",
      slug: "practice",
      order: 4,
      description: null,
    },
  };
  const page: CoursePage = {
    apiVersion: "v1",
    type: "CoursePage",
    name: "exercise",
    spec: {
      module: "practice",
      title: "Exercise",
      slug: "exercise",
      order: 9,
      content: { format: "topik", value: "# Exercise\n" },
    },
  };
  const result = await plan(
    project,
    [...project.compilation.resources, module, page],
    [
      { kind: "create", resource: "CourseModule/practice", config: "lessons/course.yaml" },
      {
        kind: "create",
        resource: "CoursePage/exercise",
        config: "lessons/course.yaml",
        path: "lessons/practice/exercise.md",
      },
    ],
    {
      authority: {
        ...authority(project),
        resources: [
          ...authority(project).resources,
          "CourseModule/practice",
          "CoursePage/exercise",
        ],
        create: ["lessons/practice/exercise.md"],
      },
    },
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(rawFile(result.plan.candidate, "lessons/pages/intro.md")).toBe(
    rawFile(project, "lessons/pages/intro.md"),
  );
  const created = result.plan.candidate;
  const orphaned = created.compilation.resources.filter(
    (resource) => resource.type !== "CourseModule" || resource.name !== "practice",
  );
  expect(
    await plan(created, orphaned, [{ kind: "delete", resource: "CourseModule/practice" }]),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "module-not-empty" }] });
  const removed = await plan(
    created,
    orphaned.filter((resource) => resource.type !== "CoursePage" || resource.name !== "exercise"),
    [
      { kind: "delete", resource: "CourseModule/practice" },
      { kind: "delete", resource: "CoursePage/exercise" },
    ],
  );
  expect(removed.ok, JSON.stringify(removed)).toBe(true);
  if (removed.ok)
    expect(removed.plan.candidate.compilation.resources).toEqual(project.compilation.resources);
});

test("a page append and module metadata insertion share their base anchor without escaping the original module", async () => {
  const original = await courseProject();
  const project = await readSourceProject({
    tree: original.tree.map((entry) =>
      entry.path === "lessons/course.yaml"
        ? file(
            entry.path,
            rawConfig
              .replace("    labels: { level: introductory }\n", "")
              .replace("    customModule: retain\n", ""),
          )
        : entry,
    ),
  });
  const desired = structuredClone(project.compilation.resources);
  resource(desired, "CourseModule", "basics").labels = { revised: "yes" };
  desired.push({
    apiVersion: "v1",
    type: "CoursePage",
    name: "new-page",
    spec: {
      module: "basics",
      title: "New page",
      slug: "new",
      order: 12,
      content: { format: "topik", value: "# New page\n" },
    },
  });
  const result = await plan(
    project,
    desired,
    [
      { kind: "update", resource: "CourseModule/basics" },
      {
        kind: "create",
        resource: "CoursePage/new-page",
        config: "lessons/course.yaml",
        path: "lessons/pages/new.md",
      },
    ],
    {
      authority: {
        ...authority(project),
        resources: [...authority(project).resources, "CoursePage/new-page"],
        create: ["lessons/pages/new.md"],
      },
    },
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.candidate.compilation.resources).toEqual(expect.arrayContaining(desired));
  expect(rawFile(result.plan.candidate, "lessons/course.yaml")).toContain(
    '      - "pages/new"\n    labels: {"revised":"yes"}\n  - id: advanced',
  );
});

test("a last-module metadata insertion precedes a new enclosing module appended at the same base anchor", async () => {
  const original = await courseProject();
  const config = rawConfig
    .slice(0, rawConfig.indexOf("  - id: advanced"))
    .replace("    labels: { level: introductory }\n", "")
    .replace("    customModule: retain\n", "");
  const project = await readSourceProject({
    tree: original.tree.map((entry) =>
      entry.path === "lessons/course.yaml" ? file(entry.path, config) : entry,
    ),
  });
  const desired = structuredClone(project.compilation.resources);
  resource(desired, "CourseModule", "basics").labels = { new: "yes" };
  desired.push({
    apiVersion: "v1",
    type: "CourseModule",
    name: "second",
    spec: { course: "fundamentals", title: "Second module", slug: "second", order: 7 },
  });
  const result = await plan(
    project,
    desired,
    [
      { kind: "update", resource: "CourseModule/basics" },
      { kind: "create", resource: "CourseModule/second", config: "lessons/course.yaml" },
    ],
    {
      authority: {
        ...authority(project),
        resources: [...authority(project).resources, "CourseModule/second"],
      },
    },
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(
    resource(result.plan.candidate.compilation.resources, "CourseModule", "basics").labels,
  ).toEqual({ new: "yes" });
  expect(
    resource(result.plan.candidate.compilation.resources, "CourseModule", "second").labels,
  ).toBeUndefined();
  expect(rawFile(result.plan.candidate, "lessons/course.yaml")).toContain(
    '    labels: {"new":"yes"}\n  - {"id":"second"',
  );
});

test("changed Course authoring content requires its complete original context when routes change", async () => {
  const project = await courseProject();
  const desired = structuredClone(project.compilation.resources);
  resource(desired, "CourseModule", "basics").spec.slug = "renamed";
  resource(desired, "CoursePage", "intro").spec.content.value += "\nSaved later.\n";
  const operations: SourceResourceOperation[] = [
    { kind: "update", resource: "CourseModule/basics" },
    { kind: "update", resource: "CoursePage/intro" },
  ];
  expect(await plan(project, desired, operations)).toMatchObject({
    ok: false,
    diagnostics: [{ code: "reference-context-required", resource: "CoursePage/intro" }],
  });
  const saved = project.courseContexts["Course/fundamentals"];
  expect(
    await plan(project, desired, operations, {
      courseReferenceContexts: {
        "CoursePage/intro": {
          ...saved,
          pages: saved.pages.filter((page) => page.name !== "intro"),
        },
      },
    }),
  ).toMatchObject({
    ok: false,
    diagnostics: [{ code: "reference-context-invalid", resource: "CoursePage/intro" }],
  });
  const result = await plan(project, desired, operations, {
    courseReferenceContexts: { "CoursePage/intro": saved },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok)
    expect(
      resource(result.plan.candidate.compilation.resources, "CoursePage", "intro").spec.content
        .value,
    ).toContain("Saved later");
  expect(
    await plan(project, desired, operations, {
      courseReferenceContexts: { "CoursePage/intro": { ...saved, course: "another-course" } },
    }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "reference-context-invalid" }] });
  expect(
    await plan(project, desired, operations, {
      courseReferenceContexts: {
        "CoursePage/intro": {
          ...saved,
          pages: saved.pages.map((page) =>
            page.name === "intro" ? { ...page, module: "missing-module" } : page,
          ),
        },
      },
    }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "reference-context-invalid" }] });
});

test("a Course route change cannot silently give an unresolved saved link a destination or rewrite an unowned referring page", async () => {
  const project = await courseProject();
  const desired = structuredClone(project.compilation.resources);
  resource(desired, "CoursePage", "target").spec.slug = "future";
  resource(desired, "CoursePage", "intro").spec.content.value =
    "# Intro\n\n[Future](/basics/future)\n";
  const operations: SourceResourceOperation[] = [
    { kind: "update", resource: "CoursePage/target" },
    { kind: "update", resource: "CoursePage/intro" },
  ];
  expect(
    await plan(project, desired, operations, {
      courseReferenceContexts: {
        "CoursePage/intro": project.courseContexts["Course/fundamentals"],
      },
    }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "reference-target-unresolved" }] });
  const move = [
    { kind: "move" as const, resource: "CoursePage/target", path: "lessons/moved/target.md" },
  ];
  expect(
    await plan(project, project.compilation.resources, move, {
      authority: {
        ...authority(project),
        resources: authority(project).resources.filter((key) => key !== "CoursePage/intro"),
        create: ["lessons/moved/target.md"],
      },
    }),
  ).toMatchObject({
    ok: false,
    diagnostics: [{ code: "resource-scope-denied", resource: "CoursePage/intro" }],
  });
});

test("shared Person edits require every Course and CoursePage author reference in admitted resource scope", async () => {
  const project = await courseProject();
  const desired = structuredClone(project.compilation.resources);
  resource(desired, "Person", "alice").spec.bio = "Updated biography";
  const config = project.configurations.find((config) => config.path === "lessons/course.yaml")!;
  const scope = {
    ...authority(project),
    shared: [
      {
        ...config,
        fields: config.fields.filter((field) => field.selector === "persons/alice/spec/bio"),
      },
    ],
  };
  expect(
    await plan(project, desired, [{ kind: "update", resource: "Person/alice" }], {
      authority: { ...scope, resources: ["Person/alice", "CoursePage/intro"] },
    }),
  ).toMatchObject({
    ok: false,
    diagnostics: [{ code: "shared-reference-scope-denied", resource: "Course/fundamentals" }],
  });
  const result = await plan(project, desired, [{ kind: "update", resource: "Person/alice" }], {
    authority: scope,
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) expect(result.plan.changes).toHaveLength(1);
});

function initializedGraph(): Resource[] {
  const course: Course = {
    apiVersion: "v1",
    type: "Course",
    name: "portable",
    labels: { audience: "all" },
    spec: { title: "Portable course", slug: "portable", description: null, authors: ["teacher"] },
  };
  const module: CourseModule = {
    apiVersion: "v1",
    type: "CourseModule",
    name: "first",
    spec: { course: "portable", title: "First module", slug: "first", order: 3 },
  };
  const page: CoursePage = {
    apiVersion: "v1",
    type: "CoursePage",
    name: "welcome",
    labels: {},
    spec: {
      module: "first",
      title: "Welcome",
      slug: "welcome",
      order: 8,
      authors: ["teacher"],
      content: { format: "topik", value: "# Welcome\n" },
    },
  };
  return [
    course,
    module,
    page,
    { apiVersion: "v1", type: "Person", name: "teacher", spec: { name: "Teacher" } },
  ];
}

test("explicit Course initialization preserves all metadata and custom paths and refuses occupied destinations", async () => {
  const tree = [file("README.txt", "unchanged\n")];
  const request = {
    tree,
    expectedTreeDigest: digestSourceTree(tree),
    packageCohort: cohort,
    intent: {
      namespace: "example/course-new",
      source: {
        kind: "course" as const,
        config: "training/course.yaml",
        id: "portable",
        title: "Portable course",
      },
    },
    resources: initializedGraph(),
    documentPaths: { "CoursePage/welcome": "training/content/start.md" },
    createPaths: [".topik.yaml", "training/course.yaml", "training/content/start.md"],
  };
  const result = await initializeSourceProject(request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.candidate.compilation.resources).toEqual(
    expect.arrayContaining(request.resources),
  );
  expect(rawFile(result.plan.candidate, "README.txt")).toBe("unchanged\n");
  expect(result.plan.candidate.courseContexts["Course/portable"].pages[0].sourcePath).toBe(
    "content/start",
  );
  const occupied = [...tree, file("training/content/start.md", "existing\n")];
  expect(
    await initializeSourceProject({
      ...request,
      tree: occupied,
      expectedTreeDigest: digestSourceTree(occupied),
    }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "initialization-collision" }] });
  expect(
    await initializeSourceProject({
      ...request,
      createPaths: request.createPaths.filter((path) => path !== "training/content/start.md"),
    }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "initialization-collision" }] });
});

test("adding a Course preserves existing namespace, source order and all unrelated source bytes", async () => {
  const existing = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "# Keep root\nversion: 1\nnamespace: example/existing\nsources:\n  - kind: collection\n    config: guides/collection.yaml # existing source\n",
      ),
      file("guides/collection.yaml", "id: guides\ntitle: Guides\nsourceVersion: 1\n"),
      file("guides/first.md", "---\nid: existing-guide\nslug: existing\n---\n# Existing\n"),
    ],
  });
  const root = existing.configurations.find((config) => config.path === ".topik.yaml")!;
  const result = await addSourceToProject({
    project: existing,
    expectedTreeDigest: existing.treeDigest,
    packageCohort: cohort,
    source: {
      kind: "course",
      config: "training/course.yaml",
      id: "portable",
      title: "Portable course",
    },
    resources: initializedGraph(),
    createPaths: ["training/course.yaml", "training/first/welcome.md"],
    manifestAuthority: {
      ...root,
      fields: root.fields.filter((field) => field.selector === "sources/+"),
    },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.plan.candidate.manifest.namespace).toBe(existing.manifest.namespace);
  expect(result.plan.candidate.manifest.sources.map((source) => source.kind)).toEqual([
    "collection",
    "course",
  ]);
  expect(rawFile(result.plan.candidate, "guides/first.md")).toBe(
    rawFile(existing, "guides/first.md"),
  );
  expect(rawFile(result.plan.candidate, ".topik.yaml")).toContain(
    "config: guides/collection.yaml # existing source",
  );
});

test("Course initialization transports retained source-relative links and exact local media bytes", async () => {
  const graph = initializedGraph();
  const intro = resource(graph, "CoursePage", "welcome");
  const assetName = generateAutomaticAssetName({
    projectNamespace: "example/saved-course",
    manifestRelativePath: "pixel.png",
  }).value!;
  intro.spec.content.value = `# Welcome\n\n[Next](./next.md?x=1#details)\n\n![Pixel](asset:${assetName})\n`;
  const next: CoursePage = {
    apiVersion: "v1",
    type: "CoursePage",
    name: "next",
    spec: {
      module: "first",
      title: "Next",
      slug: "destination",
      order: 9,
      content: { format: "topik", value: "# Next\n\n## Details\n" },
    },
  };
  const bytes = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  graph.push(next, {
    apiVersion: "v1",
    type: "Asset",
    name: assetName,
    spec: {
      uri: parseAssetBlobUri(`blobs/${sourceHash(bytes)}`),
      mediaType: "image/png",
      integrity: `sha256:${sourceHash(bytes)}`,
      size: bytes.length,
    },
  });
  const context = {
    course: "portable",
    modules: [{ name: "first", slug: "first" }],
    pages: [
      { name: "welcome", module: "first", slug: "welcome", sourcePath: "old/index" },
      { name: "next", module: "first", slug: "destination", sourcePath: "old/next" },
    ],
  };
  const mediaPath = `training/_assets/pixel-${sourceHash(encodeSource(assetName)).slice(0, 8)}.png`;
  const result = await initializeSourceProject({
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "example/course-media",
      source: {
        kind: "course",
        config: "training/course.yaml",
        id: "portable",
        title: "Portable course",
      },
    },
    resources: graph,
    documentPaths: {
      "CoursePage/welcome": "training/new/index.md",
      "CoursePage/next": "training/relocated/next.md",
    },
    courseReferenceContexts: { "CoursePage/welcome": context, "CoursePage/next": context },
    media: [{ name: assetName, filename: "pixel.png", sha256: sourceHash(bytes), bytes }],
    createPaths: [
      ".topik.yaml",
      "training/course.yaml",
      "training/new/index.md",
      "training/relocated/next.md",
      mediaPath,
    ],
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(rawFile(result.plan.candidate, "training/new/index.md")).toContain(
    "/first/destination?x=1#details",
  );
  expect(result.plan.candidate.tree.find((file) => file.path === mediaPath)?.bytes).toEqual(bytes);
  expect(result.plan.assetMappings).toMatchObject([{ from: assetName, path: mediaPath }]);
  const current = result.plan.candidate;
  const previousAsset = resource(current.compilation.resources, "Asset");
  const replacementName = generateAutomaticAssetName({
    projectNamespace: "example/replacement",
    manifestRelativePath: "new.png",
  }).value!;
  const desired: Resource[] = structuredClone(current.compilation.resources).filter(
    (resource) => resource.type !== "Asset",
  );
  desired.push({ ...previousAsset, name: replacementName });
  const replacementPath = `training/_assets/updated-${sourceHash(encodeSource(replacementName)).slice(0, 8)}.png`;
  const update = await plan(
    current,
    desired,
    [{ kind: "update", resource: "CoursePage/welcome" }],
    {
      assetReferenceContexts: { "CoursePage/welcome": { [previousAsset.name]: replacementName } },
      media: [
        {
          config: "training/course.yaml",
          name: replacementName,
          filename: "updated.png",
          sha256: sourceHash(bytes),
          bytes,
        },
      ],
      authority: { ...authority(current), create: [replacementPath] },
    },
  );
  expect(update.ok, JSON.stringify(update)).toBe(true);
  if (update.ok) {
    expect(update.plan.candidate.tree.find((file) => file.path === replacementPath)?.bytes).toEqual(
      bytes,
    );
    expect(
      resource(update.plan.candidate.compilation.resources, "CoursePage", "welcome").spec.content
        .value,
    ).toContain(`asset:${update.plan.assetMappings[0].to}`);
    expect(resource(update.plan.candidate.compilation.resources, "CoursePage", "next")).toEqual(
      resource(current.compilation.resources, "CoursePage", "next"),
    );
  }
});
