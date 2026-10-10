import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  parseDocument,
  sameDocumentMeaning,
  writeDocument,
  extractTopikAssetOccurrences,
  TOPIK_CONTENT_SCHEMA_VERSION,
} from "@topik/content";
import {
  readSourceProject,
  planSourceUpdates,
  initializeSourceProject,
  addSourceToProject,
  digestSourceTree,
  SOURCE_WRITER_DESCRIPTOR,
  validateTopikMaterializationRecord,
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
  const body = [
    "# Original",
    "",
    '{% callout title=t"Hello {% $name %}" %}',
    "Body",
    "{% /callout %}",
    "",
    "{% template code %}",
    "```sh",
    "echo {% $name %}",
    "```",
    "{% /template code %}",
    "",
    String.raw`{% math content="a\nb" /%}`,
    "",
  ].join("\r\n");
  const authored = `---\r\nid: stable\r\ntitle: Original # keep\r\ncustom: exact\r\n---\r\n${body}`;
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: packed/example\nsources: [{kind: collection, config: guides/custom.yml}]\n",
      ),
      file("guides/custom.yml", "id: blog\ntitle: Blog\nsourceVersion: 1\n"),
      file("guides/page.md", authored, "100755"),
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
    authored.replace("title: Original # keep", 'title: "Edited" # keep'),
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
  const edited = structuredClone(plan.candidate.compilation.resources);
  const editedGuide = edited.find((resource) => resource.type === "Guide");
  editedGuide.spec.content.value = editedGuide.spec.content.value.replaceAll(
    "$name",
    "$displayName",
  );
  const bodyEdit = await planSourceUpdates({
    project: plan.candidate,
    expectedTreeDigest: plan.candidateTreeDigest,
    packageCohort,
    desiredResources: edited,
    operations: [{ kind: "update", resource: "Guide/stable" }],
    authority: authority(plan.candidate),
  });
  assert.equal(bodyEdit.ok, true, JSON.stringify(bodyEdit));
  const candidateBody = bodyEdit.plan.candidate.compilation.resources.find(
    (resource) => resource.type === "Guide",
  ).spec.content.value;
  const before = parseDocument(editedGuide.spec.content.value);
  const after = parseDocument(candidateBody);
  assert.ok(before.ok && after.ok);
  assert.equal(sameDocumentMeaning(before.document, after.document), true);
  assert.ok(candidateBody.includes('title=t"Hello {% $displayName %}"'));
  assert.ok(candidateBody.includes("echo {% $displayName %}"));
  assert.ok(candidateBody.includes(String.raw`content="a\nb"`));
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

/** Guide and Wiki plans retain the unevaluated presentation grammar in packed artifacts. */
export async function verifyPresentationSourceConsumer(packageCohort = "c".repeat(64)) {
  assert.equal(SOURCE_WRITER_DESCRIPTOR.contentSchema, TOPIK_CONTENT_SCHEMA_VERSION);
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  const body = [
    "# Original",
    "",
    '```ts filename="missing.png" title="A &#38;amp; label" highlight="1,2" lines collapseAfter=1  legacy&#38;amp; &#92; &#96;',
    "\tconst first = 1;  ",
    "",
    "```",
    "",
    "{% if $install %}",
    "{% template code %}",
    '```sh title="Install"',
    "npm install {% $package.name %}",
    "```",
    "{% /template code %}",
    "{% else /%}",
    '```text title="Alternative"',
    "![Code only](missing.png)",
    "```",
    "{% /if %}",
    "",
    "![Actual image](hero.png)",
    "",
  ].join("\r\n");
  const presentations = (source) => {
    const parsed = parseDocument(source);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const nodes = [];
    const visit = (node) => {
      if (node.type === "topikCodePresentation") nodes.push(node);
      node.children?.forEach(visit);
    };
    visit(parsed.document);
    assert.equal(nodes.length, 3);
    return { document: parsed.document, nodes };
  };
  for (const kind of ["collection", "wiki"]) {
    const directory = kind === "collection" ? "guides" : "docs";
    const config = `${directory}/config.yaml`;
    const path = `${directory}/page.md`;
    const resourceKey = `${kind === "collection" ? "Guide" : "WikiPage"}/stable`;
    const authored = `---\r\nid: stable\r\ntitle: Original # keep\r\ncustom: exact\r\n---\r\n${body}`;
    const project = await readSourceProject({
      tree: [
        file(
          ".topik.yaml",
          `version: 1\nnamespace: packed/presentation\nsources: [{kind: ${kind}, config: ${config}}]\n`,
        ),
        file(
          config,
          `id: examples\ntitle: Examples\nsourceVersion: 1\n${kind === "wiki" ? "navigation: [page, sibling]\n" : ""}`,
        ),
        file(path, authored, "100755"),
        file(`${directory}/sibling.md`, "---\nid: sibling\n---\n# Sibling\n"),
        { path: `${directory}/hero.png`, mode: "100644", bytes: png },
        file("README.md", "Exact unowned bytes\r\n", "100755"),
      ],
    });
    const selected = (resources) =>
      resources.find((entry) => `${entry.type}/${entry.name}` === resourceKey);
    const original = presentations(selected(project.compilation.resources).spec.content.value);
    assert.equal(original.nodes[0].children[0].value, "\tconst first = 1;  \n");
    assert.equal(original.nodes[0].options.title, "A &amp; label");
    assert.equal(original.nodes[0].opaqueMetaSuffix, "  legacy&amp; \\ `");
    assert.equal(original.nodes[1].children[0].type, "topikCodeTemplate");
    assert.equal(project.compilation.semantic.assetNames.length, 1);
    assert.equal(
      extractTopikAssetOccurrences(selected(project.compilation.resources).spec.content.value)
        .length,
      1,
    );
    const provenance = project.documents.find((entry) => entry.resource === resourceKey);
    const admitted = {
      resources: [resourceKey],
      exclusive: [{ path, mode: provenance.mode, sha256: provenance.sha256 }],
      shared: [],
      create: [],
    };
    const desired = structuredClone(project.compilation.resources);
    selected(desired).spec.title = "Edited";
    const metadata = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort,
      desiredResources: desired,
      operations: [{ kind: "update", resource: resourceKey }],
      authority: admitted,
    });
    assert.equal(metadata.ok, true, JSON.stringify(metadata));
    assert.equal(metadata.plan.changes.length, 1);
    assert.equal(
      decode(metadata.plan.changes[0].candidate.bytes),
      authored.replace("title: Original # keep", 'title: "Edited" # keep'),
    );
    const fresh = await readSourceProject({ tree: metadata.plan.candidate.tree });
    assert.deepEqual(fresh.compilation.resources, desired);
    for (const before of project.tree.filter((entry) => entry.path !== path))
      assert.deepEqual(
        fresh.tree.find((entry) => entry.path === before.path),
        before,
      );
    const edited = structuredClone(fresh.compilation.resources);
    const parsed = presentations(selected(edited).spec.content.value);
    parsed.nodes[0].options.title = "Edited &amp; label";
    selected(edited).spec.content.value = writeDocument(parsed.document);
    const bodyEdit = await planSourceUpdates({
      project: fresh,
      expectedTreeDigest: fresh.treeDigest,
      packageCohort,
      desiredResources: edited,
      operations: [{ kind: "update", resource: resourceKey }],
      authority: {
        resources: [resourceKey],
        exclusive: fresh.documents
          .filter((entry) => entry.resource === resourceKey)
          .map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
        shared: [],
        create: [],
      },
    });
    assert.equal(bodyEdit.ok, true, JSON.stringify(bodyEdit));
    const candidate = await readSourceProject({ tree: bodyEdit.plan.candidate.tree });
    assert.equal(bodyEdit.plan.changes.length, 1);
    assert.equal(bodyEdit.plan.changes[0].path, path);
    for (const before of project.tree.filter((entry) => entry.path !== path))
      assert.deepEqual(
        candidate.tree.find((entry) => entry.path === before.path),
        before,
      );
    const after = presentations(selected(candidate.compilation.resources).spec.content.value);
    assert.equal(sameDocumentMeaning(parsed.document, after.document), true);
    assert.deepEqual(candidate.compilation.semantic, project.compilation.semantic);
    assert.deepEqual(
      candidate.compilation.resources.filter((entry) => entry.type === "Asset"),
      project.compilation.resources.filter((entry) => entry.type === "Asset"),
    );
    assert.deepEqual(
      candidate.compilation.materialization.payloads,
      project.compilation.materialization.payloads,
    );
    assert.equal(
      validateTopikMaterializationRecord(
        candidate.compilation.materialization,
        candidate.compilation.resources,
        candidate.compilation.semantic,
      ).ok,
      true,
    );
    assert.equal(
      validateTopikMaterializationRecord(
        fresh.compilation.materialization,
        candidate.compilation.resources,
        candidate.compilation.semantic,
      ).ok,
      false,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifySourceWritebackConsumer();
  await verifyCourseSourceConsumer();
  await verifyPresentationSourceConsumer();
  console.log(
    "Verified packed Guide, Wiki presentation and Course source inspection, updates, moves, initialization and source addition",
  );
}
