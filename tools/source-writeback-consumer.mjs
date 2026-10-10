import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { parseDocument, sameDocumentMeaning } from "@topik/content";
import {
  readSourceProject,
  planSourceUpdates,
  initializeSourceProject,
  addSourceToProject,
  digestSourceTree,
  SOURCE_WRITER_DESCRIPTOR,
} from "@topik/core";

const encode = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);
const file = (path, text, mode = "100644") => ({ path, mode, bytes: encode(text) });
const authority = (project) => ({
  resources: project.compilation.resources.map((resource) => `${resource.type}/${resource.name}`),
  exclusive: project.documents
    .filter((document) => /\.mdx?$/.test(document.path))
    .map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
  shared: project.configurations.filter((config) => config.path !== ".topik.yaml"),
  create: [],
});

/** Public artifacts alone must perform a source-preserving round trip. */
export async function verifySourceWritebackConsumer(packageCohort = "c".repeat(64)) {
  assert.equal(SOURCE_WRITER_DESCRIPTOR.writer, "topik-source-writer-v1");
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: packed/example\nsources: [{kind: collection, config: guides/custom.yml}]\n",
      ),
      file("guides/custom.yml", "id: blog\ntitle: Blog\nsourceVersion: 1\n"),
      file(
        "guides/page.md",
        "---\r\nid: stable\r\ntitle: Original # keep\r\ncustom: exact\r\n---\r\n# Original\r\n",
        "100755",
      ),
      file("README.md", "Unowned exact bytes\r\n", "100755"),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  desired[0].spec.title = "Edited";
  const admitted = authority(project);
  const planned = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Guide/stable" }],
    authority: admitted,
  });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const plan = planned.plan;
  assert.equal(plan.changes.length, 1);
  assert.equal(
    decode(plan.changes[0].candidate.bytes),
    '---\r\nid: stable\r\ntitle: "Edited" # keep\r\ncustom: exact\r\n---\r\n# Original\r\n',
  );
  assert.equal(plan.changes[0].candidate.mode, "100755");
  assert.deepEqual(
    plan.candidate.tree.find((file) => file.path === "README.md"),
    project.tree.find((file) => file.path === "README.md"),
  );
  const repeated = await planSourceUpdates({
    project: plan.candidate,
    expectedTreeDigest: plan.candidateTreeDigest,
    packageCohort,
    desiredResources: desired,
    operations: [],
    authority: authority(plan.candidate),
  });
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.plan.changes.length, 0);
  const denied = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Guide/stable" }],
    authority: { ...admitted, exclusive: [] },
  });
  assert.equal(denied.ok, false);
  assert.equal(Object.hasOwn(denied, "plan"), false);

  const resources = [
    {
      apiVersion: "v1",
      type: "Guide",
      name: "created",
      spec: {
        title: "Created",
        slug: "created",
        authors: ["ada"],
        content: { format: "topik", value: "# Created\n" },
      },
    },
    {
      apiVersion: "v1",
      type: "Person",
      name: "ada",
      spec: { name: "Ada", email: null, bio: "Author" },
    },
  ];
  const occupied = [file("README.md", "Unowned\n", "100755")];
  const source = { kind: "collection", config: "blog/custom.yaml", id: "blog", title: "Blog" };
  const created = await initializeSourceProject({
    tree: occupied,
    expectedTreeDigest: digestSourceTree(occupied),
    packageCohort,
    intent: { namespace: "packed/new", source },
    resources,
    createPaths: [".topik.yaml", source.config, "blog/created.md"],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.deepEqual(
    (await readSourceProject({ tree: created.plan.candidate.tree })).compilation.resources,
    resources,
  );
  const empty = await readSourceProject({
    tree: [
      ...occupied,
      file(".topik.yaml", "# preserve\nversion: 1\nnamespace: packed/empty\nsources: []\n"),
    ],
  });
  const root = empty.configurations.find((config) => config.path === ".topik.yaml");
  const added = await addSourceToProject({
    project: empty,
    expectedTreeDigest: empty.treeDigest,
    packageCohort,
    source,
    resources,
    createPaths: [source.config, "blog/created.md"],
    manifestAuthority: {
      ...root,
      fields: root.fields.filter((field) => field.selector === "sources/+"),
    },
  });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.plan.candidate.manifest.namespace, "packed/empty");
  assert.equal(
    decode(added.plan.candidate.tree.find((file) => file.path === ".topik.yaml").bytes).startsWith(
      "# preserve\nversion: 1\nnamespace: packed/empty\n",
    ),
    true,
  );
  return { project, plan, authority: admitted };
}

/** Course compilation and writing use public packages without an application adapter. */
export async function verifyCourseSourceConsumer(packageCohort = "c".repeat(64)) {
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: packed/course\nsources: [{kind: course, config: course/course.yaml}]\n",
      ),
      file(
        "course/course.yaml",
        "# Keep course configuration\nid: training\ntitle: Training\nslug: training\nsourceVersion: 1\nauthors: [ada]\npersons: [{id: ada, spec: {name: Ada, email: null, bio: Teacher}}]\ncustom: exact\nmodules:\n  - id: foundations\n    title: Foundations\n    slug: foundations\n    order: 0\n    pages: [lessons/intro, lessons/next]\n",
      ),
      file(
        "course/lessons/intro.md",
        "---\r\nid: intro\r\ntitle: Original # keep\r\nslug: introduction\r\norder: 0\r\nauthors: [ada]\r\ncustom: exact\r\n---\r\n# Intro\r\n\r\n[Next](next.md?mode=read#topic)\r\n",
        "100755",
      ),
      file(
        "course/lessons/next.md",
        "---\nid: next\ntitle: Next\nslug: next\norder: 1\n---\n# Topic\n",
      ),
      file("README.md", "Unowned exact bytes\r\n", "100755"),
    ],
  });
  const context = project.courseContexts["Course/training"];
  assert.ok(context);
  const desired = structuredClone(project.compilation.resources);
  const page = desired.find(
    (resource) => resource.type === "CoursePage" && resource.name === "intro",
  );
  assert.ok(page);
  page.spec.title = "Edited lesson";
  const updated = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "CoursePage/intro" }],
    authority: authority(project),
    courseReferenceContexts: { "CoursePage/intro": context },
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.plan.changes.length, 1);
  assert.equal(updated.plan.changes[0].path, "course/lessons/intro.md");
  assert.equal(updated.plan.changes[0].candidate.mode, "100755");
  assert.ok(
    decode(updated.plan.changes[0].candidate.bytes).includes('title: "Edited lesson" # keep\r\n'),
  );
  assert.ok(
    decode(updated.plan.changes[0].candidate.bytes).endsWith(
      "# Intro\r\n\r\n[Next](next.md?mode=read#topic)\r\n",
    ),
  );
  assert.deepEqual(
    updated.plan.candidate.tree.find((entry) => entry.path === "course/course.yaml"),
    project.tree.find((entry) => entry.path === "course/course.yaml"),
  );

  const moved = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort,
    desiredResources: project.compilation.resources,
    operations: [{ kind: "move", resource: "CoursePage/next", path: "course/moved/next.md" }],
    authority: { ...authority(project), create: ["course/moved/next.md"] },
  });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.deepEqual(
    moved.plan.candidate.tree.find((entry) => entry.path === "README.md"),
    project.tree.find((entry) => entry.path === "README.md"),
  );
  assert.equal(
    moved.plan.candidate.documents.find((entry) => entry.resource === "CoursePage/next").path,
    "course/moved/next.md",
  );

  const occupied = [file("README.md", "Unowned\n", "100755")];
  const source = {
    kind: "course",
    config: "course/course.yaml",
    id: "training",
    title: "Training",
  };
  const documentPaths = {
    "CoursePage/intro": "course/lessons/intro.md",
    "CoursePage/next": "course/lessons/next.md",
  };
  const courseReferenceContexts = { "CoursePage/intro": context, "CoursePage/next": context };
  const assertCreatedResources = (actual) => {
    const expected = structuredClone(project.compilation.resources);
    for (const page of expected.filter((resource) => resource.type === "CoursePage")) {
      const compiled = actual.find(
        (resource) => resource.type === "CoursePage" && resource.name === page.name,
      );
      assert.ok(compiled);
      const before = parseDocument(page.spec.content.value);
      const after = parseDocument(compiled.spec.content.value);
      assert.ok(before.ok && after.ok);
      assert.equal(sameDocumentMeaning(before.document, after.document), true);
      // Newly created files use the content writer's formatting; metadata remains exact.
      page.spec.content.value = compiled.spec.content.value;
    }
    assert.deepEqual(actual, expected);
  };
  const created = await initializeSourceProject({
    tree: occupied,
    expectedTreeDigest: digestSourceTree(occupied),
    packageCohort,
    intent: { namespace: "packed/new-course", source },
    resources: project.compilation.resources,
    documentPaths,
    courseReferenceContexts,
    createPaths: [".topik.yaml", source.config, ...Object.values(documentPaths)],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assertCreatedResources(created.plan.candidate.compilation.resources);

  const empty = await readSourceProject({
    tree: [
      ...occupied,
      file(".topik.yaml", "# Keep namespace\nversion: 1\nnamespace: packed/empty\nsources: []\n"),
    ],
  });
  const root = empty.configurations.find((entry) => entry.path === ".topik.yaml");
  const added = await addSourceToProject({
    project: empty,
    expectedTreeDigest: empty.treeDigest,
    packageCohort,
    source,
    resources: project.compilation.resources,
    documentPaths,
    courseReferenceContexts,
    createPaths: [source.config, ...Object.values(documentPaths)],
    manifestAuthority: {
      ...root,
      fields: root.fields.filter((entry) => entry.selector === "sources/+"),
    },
  });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.plan.candidate.manifest.namespace, "packed/empty");
  assertCreatedResources(added.plan.candidate.compilation.resources);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifySourceWritebackConsumer();
  await verifyCourseSourceConsumer();
  console.log(
    "Verified packed Guide and Course source inspection, updates, moves, initialization and source addition",
  );
}
