import { expect, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import type { Person } from "@topik/schema/person/v1";
import type { Resource } from "../resource";
import { addSourceToProject, initializeSourceProject } from "./initialize";
import { planSourceUpdates, type SourceResourceOperation } from "./plan";
import {
  digestSourceResourceGraph,
  digestSourceTree,
  readSourceProject,
  type SourceProject,
} from "./project";
import { decodeSource, encodeSource } from "./syntax";

const cohort = "a".repeat(64);
const file = (path: string, raw: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(raw),
});
const person = (name: string, display = name): Person => ({
  apiVersion: "v1",
  type: "Person",
  name,
  spec: { name: display },
});
const guide = (name: string, authors: string[]): Guide => ({
  apiVersion: "v1",
  type: "Guide",
  name,
  spec: {
    title: name,
    slug: name,
    authors,
    content: { format: "topik", value: `# ${name}\n` },
  },
});
const writtenIn = (tree: readonly { path: string; bytes: Uint8Array }[], path: string) =>
  decodeSource(tree.find((entry) => entry.path === path)!.bytes);

test("initialization declares Persons in the new manifest, not the source configuration", async () => {
  const result = await initializeSourceProject({
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "examples/persons",
      source: { kind: "collection", config: "blog/collection.yaml", id: "blog", title: "Blog" },
    },
    resources: [person("ada", "Ada"), guide("post", ["ada"])],
    createPaths: [".topik.yaml", "blog/collection.yaml", "blog/post.md"],
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const { tree } = result.plan.candidate;
  expect(writtenIn(tree, ".topik.yaml")).toContain(
    'persons:\n  - {"id":"ada","spec":{"name":"Ada"}}\n',
  );
  expect(writtenIn(tree, "blog/collection.yaml")).not.toContain("persons");
  expect(result.plan.candidate.compilation.resources).toContainEqual(person("ada", "Ada"));
});

/** A project with one collection whose Guide is authored by a manifest Person. */
async function projectWith(manifest: string) {
  return readSourceProject({
    tree: [
      file(".topik.yaml", manifest),
      file("blog/collection.yaml", "id: blog\ntitle: Blog\n"),
      file("blog/post.md", "---\nid: post\nauthors: [ada]\n---\n# Post\n"),
    ],
  });
}
const withAda =
  "version: 1\nnamespace: examples/persons\nsources:\n  - { kind: collection, config: blog/collection.yaml }\npersons:\n  - { id: ada, spec: { name: Ada } }\n";

async function addNotes(project: SourceProject, resources: Resource[]) {
  const manifest = project.configurations.find((config) => config.path === ".topik.yaml")!;
  return addSourceToProject({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    source: { kind: "collection", config: "notes/collection.yaml", id: "notes", title: "Notes" },
    resources,
    createPaths: ["notes/collection.yaml", "notes/note.md"],
    manifestAuthority: manifest,
  });
}

test("a new source reuses a Person the manifest already declares", async () => {
  const project = await projectWith(withAda);
  const result = await addNotes(project, [person("ada", "Ada"), guide("note", ["ada"])]);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(writtenIn(result.plan.candidate.tree, ".topik.yaml")).toBe(
    withAda.replace(
      "persons:",
      '  - {"kind":"collection","config":"notes/collection.yaml"}\npersons:',
    ),
  );
  // The desired graph holds the shared Person once.
  expect(result.plan.desiredGraphDigest).toBe(
    digestSourceResourceGraph([...project.compilation.resources, guide("note", ["ada"])]),
  );
  // Without restating it, the new source's authors resolve to the shared Person too.
  expect((await addNotes(project, [guide("note", ["ada"])])).ok).toBe(true);
});

test("a new source cannot redeclare a Person differently", async () => {
  const project = await projectWith(withAda);
  const result = await addNotes(project, [person("ada", "Ada L."), guide("note", ["ada"])]);
  expect(result.ok ? [] : result.diagnostics).toMatchObject([
    { code: "person-conflict", resource: "Person/ada" },
  ]);
});

test.each([
  ["after the sources", withAda, `${withAda}  - {"id":"bob","spec":{"name":"Bob"}}\n`],
  [
    "before the sources",
    "version: 1\nnamespace: examples/persons\npersons:\n  - { id: ada, spec: { name: Ada } }\nsources:\n  - { kind: collection, config: blog/collection.yaml }\n",
    'version: 1\nnamespace: examples/persons\npersons:\n  - { id: ada, spec: { name: Ada } }\n  - {"id":"bob","spec":{"name":"Bob"}}\nsources:\n  - { kind: collection, config: blog/collection.yaml }\n  - {"kind":"collection","config":"notes/collection.yaml"}\n',
  ],
])(
  "a new source appends its new Persons to the manifest's, listed %s",
  async (_, manifest, expected) => {
    const project = await projectWith(manifest);
    const result = await addNotes(project, [person("bob", "Bob"), guide("note", ["ada", "bob"])]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const written = writtenIn(result.plan.candidate.tree, ".topik.yaml");
    if (manifest === withAda)
      expect(written).toBe(
        expected.replace(
          "persons:",
          '  - {"kind":"collection","config":"notes/collection.yaml"}\npersons:',
        ),
      );
    else expect(written).toBe(expected);
  },
);

test("a new source adds the persons key after the sources when the manifest has none", async () => {
  const bare =
    "version: 1\nnamespace: examples/persons\nsources:\n  - { kind: collection, config: blog/collection.yaml }\n";
  const project = await readSourceProject({
    tree: [file(".topik.yaml", bare), file("blog/collection.yaml", "id: blog\ntitle: Blog\n")],
  });
  const result = await addNotes(project, [person("bob", "Bob"), guide("note", ["bob"])]);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(writtenIn(result.plan.candidate.tree, ".topik.yaml")).toBe(
    `${bare}  - {"kind":"collection","config":"notes/collection.yaml"}\npersons: [{"id":"bob","spec":{"name":"Bob"}}]\n`,
  );
});

/** Plan Person edits with authority over every file, the manifest included. */
async function planPersons(
  project: SourceProject,
  edit: (desired: Resource[]) => SourceResourceOperation[],
) {
  const desired = structuredClone(project.compilation.resources);
  const operations = edit(desired);
  return planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations,
    authority: {
      resources: [...project.compilation.resources, ...desired].map(
        (resource) => `${resource.type}/${resource.name}`,
      ),
      exclusive: project.documents
        .filter((document) => document.path.endsWith(".md"))
        .map(({ path, sha256, mode }) => ({ path, sha256, mode })),
      shared: project.configurations,
      create: [],
    },
  });
}
const changed = (result: Awaited<ReturnType<typeof planPersons>>) =>
  result.ok
    ? Object.fromEntries(
        result.plan.changes.map((change) => [change.path, decodeSource(change.candidate!.bytes)]),
      )
    : result.diagnostics;

test("a Person edit changes only its record in the manifest", async () => {
  const project = await projectWith(`# Project\n${withAda}`);
  const result = await planPersons(project, (desired) => {
    (desired.find((resource) => resource.name === "ada") as Person).spec.name = "Ada Lovelace";
    return [{ kind: "update", resource: "Person/ada" }];
  });
  expect(changed(result)).toEqual({
    ".topik.yaml": `# Project\n${withAda.replace("{ name: Ada }", '{ name: "Ada Lovelace" }')}`,
  });
});

test("a Person is created in and deleted from the manifest", async () => {
  const project = await projectWith(withAda);
  const created = await planPersons(project, (desired) => {
    desired.push(person("bob", "Bob"));
    return [{ kind: "create", resource: "Person/bob", config: ".topik.yaml" }];
  });
  expect(changed(created)).toEqual({
    ".topik.yaml": `${withAda}  - {"id":"bob","spec":{"name":"Bob"}}\n`,
  });
  const elsewhere = await planPersons(project, (desired) => {
    desired.push(person("bob", "Bob"));
    return [{ kind: "create", resource: "Person/bob", config: "blog/collection.yaml" }];
  });
  expect(changed(elsewhere)).toMatchObject([
    { code: "source-mapping-missing", resource: "Person/bob" },
  ]);
  const removed = await planPersons(
    await projectWith(`${withAda}  - { id: bob, spec: { name: Bob } }\n`),
    (desired) => {
      desired.splice(
        desired.findIndex((resource) => resource.name === "bob"),
        1,
      );
      return [{ kind: "delete", resource: "Person/bob" }];
    },
  );
  expect(changed(removed)).toEqual({ ".topik.yaml": withAda });
});

test("a Person created in a manifest without persons adds the key", async () => {
  const bare =
    "version: 1\nnamespace: examples/persons\nsources:\n  - { kind: collection, config: blog/collection.yaml }\n";
  const project = await readSourceProject({
    tree: [file(".topik.yaml", bare), file("blog/collection.yaml", "id: blog\ntitle: Blog\n")],
  });
  const result = await planPersons(project, (desired) => {
    desired.push(person("bob", "Bob"));
    return [{ kind: "create", resource: "Person/bob", config: ".topik.yaml" }];
  });
  expect(changed(result)).toEqual({
    ".topik.yaml": `${bare}persons: [{"id":"bob","spec":{"name":"Bob"}}]\n`,
  });
});

test("a Person's provenance names the manifest", async () => {
  const project = await projectWith(withAda);
  expect(project.documents.find((document) => document.resource === "Person/ada")).toMatchObject({
    path: ".topik.yaml",
    config: ".topik.yaml",
    kind: "manifest",
    directory: "",
  });
});

test("adding a source's new Person needs authority over the manifest's persons", async () => {
  const project = await projectWith(withAda);
  const manifest = project.configurations.find((config) => config.path === ".topik.yaml")!;
  const add = (selectors: string[]) =>
    addSourceToProject({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      source: { kind: "collection", config: "notes/collection.yaml", id: "notes", title: "Notes" },
      resources: [person("bob", "Bob"), guide("note", ["bob"])],
      createPaths: ["notes/collection.yaml", "notes/note.md"],
      manifestAuthority: {
        ...manifest,
        fields: manifest.fields.filter((field) => selectors.includes(field.selector)),
      },
    });
  expect((await add(["sources/+"])).ok).toBe(false);
  expect((await add(["sources/+", "persons/+"])).ok).toBe(true);
});

test("a Person is created in the empty list deleting the last one leaves", async () => {
  const project = await projectWith(withAda);
  const removed = await planPersons(project, (desired) => {
    desired.splice(
      desired.findIndex((resource) => resource.type === "Person"),
      1,
    );
    (desired.find((resource) => resource.type === "Guide") as Guide).spec.authors = [];
    return [
      { kind: "delete", resource: "Person/ada" },
      { kind: "update", resource: "Guide/post" },
    ];
  });
  expect(removed.ok, JSON.stringify(removed)).toBe(true);
  if (!removed.ok) return;
  const emptied = removed.plan.candidate;
  expect(writtenIn(emptied.tree, ".topik.yaml")).toContain("persons:\n  []\n");
  const created = await planPersons(emptied, (desired) => {
    desired.push(person("bob", "Bob"));
    return [{ kind: "create", resource: "Person/bob", config: ".topik.yaml" }];
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  if (created.ok) expect(created.plan.candidate.manifest.persons).toEqual([person("bob", "Bob")]);
});

test("a Wiki initialization declares supplied Persons in the manifest", async () => {
  const result = await initializeSourceProject({
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "examples/persons",
      source: { kind: "wiki", config: "wiki.yaml", id: "docs", title: "Docs" },
    },
    resources: [
      {
        apiVersion: "v1",
        type: "Wiki",
        name: "docs",
        spec: { title: "Docs", navigation: [{ type: "page", page: "home", slug: "" }] },
      },
      {
        apiVersion: "v1",
        type: "WikiPage",
        name: "home",
        spec: { title: "Home", wiki: "docs", content: { format: "topik", value: "# Home\n" } },
      },
      person("ada", "Ada"),
    ],
    createPaths: [".topik.yaml", "wiki.yaml", "index.md"],
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) expect(result.plan.candidate.manifest.persons).toEqual([person("ada", "Ada")]);
});
