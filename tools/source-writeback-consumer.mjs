import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifySourceWritebackConsumer();
  console.log(
    "Verified packed source inspection, update, no-op, initialization and source addition",
  );
}
