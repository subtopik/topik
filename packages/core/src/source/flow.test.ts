import { expect, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import { addSourceToProject } from "./initialize";
import { readSourceProject, type SourceProject } from "./project";
import { planSourceUpdates, verifySharedEdits, type SourceWriteAuthority } from "./plan";
import {
  decodeSource,
  encodeSource,
  inspectSourceSyntax,
  patchSourceFields,
  patchSourceSequence,
  replaySourceByteEdits,
  sourceHash,
  type SourceByteEdit,
} from "./syntax";

const cohort = "a".repeat(64);
const file = (path: string, raw: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(raw),
});
function checkEdits(raw: string, edits: SourceByteEdit[], selected: string[]) {
  const syntax = inspectSourceSyntax(raw);
  const base = file("config.yaml", raw);
  const provenance = {
    ...base,
    sha256: sourceHash(base.bytes),
    fields: [...syntax.fields.values()],
    insertion: syntax.insertion,
  };
  const authority = {
    ...provenance,
    fields: provenance.fields.filter((field) => selected.includes(field.selector)),
  };
  expect(() => verifySharedEdits(base, provenance, authority, edits)).not.toThrow();
  if (edits.length)
    expect(() =>
      verifySharedEdits(base, provenance, { ...authority, fields: [] }, edits),
    ).toThrow();
  return replaySourceByteEdits(base.bytes, edits);
}

const cases = ["\n", "\r\n"].flatMap((eol) =>
  [false, true].flatMap((trailing) =>
    [false, true].flatMap((add) =>
      Array.from({ length: 8 }, (_, remove) => ({ eol, trailing, add, remove })),
    ),
  ),
);
test.each(cases)(
  "flow map delimiters preserve comments and narrow evidence: %j",
  ({ eol, trailing, add, remove }) => {
    const raw =
      `{a: 'Café', # after-a ,\n b: [1, 2], # after-b ,\n c: {nested: true}${trailing ? "," : ""} # after-c ,\n}\n`.replaceAll(
        "\n",
        eol,
      );
    const original = { a: "Café", b: [1, 2], c: { nested: true } };
    const updates: Record<string, unknown> = {};
    const expected: Record<string, unknown> = { ...original };
    const selected: string[] = [];
    for (const [index, key] of ["a", "b", "c"].entries())
      if (remove & (1 << index)) {
        updates[key] = undefined;
        delete expected[key];
        selected.push(key);
      }
    if (add) {
      updates.d = "Added";
      expected.d = "Added";
      selected.push("+");
    }
    const patched = patchSourceFields(raw, updates);
    expect(checkEdits(raw, patched.edits, selected)).toEqual(patched.bytes);
    const written = decodeSource(patched.bytes);
    expect(inspectSourceSyntax(written).value).toEqual(expected);
    for (const comment of ["# after-a ,", "# after-b ,", "# after-c ,"])
      expect(written).toContain(comment);
    if (!(remove & 1)) expect(written).toContain("a: 'Café'");
    if (!(remove & 2)) expect(written).toContain("b: [1, 2]");
    if (!(remove & 4)) expect(written).toContain("c: {nested: true}");
    if (!remove && !add) expect(patched).toEqual({ bytes: encodeSource(raw), edits: [] });
    expect(patchSourceFields(written, {}).bytes).toEqual(patched.bytes);
  },
);

test.each(cases)(
  "flow sequence delimiters preserve comments and narrow evidence: %j",
  ({ eol, trailing, add, remove }) => {
    const raw =
      `persons: [{id: a, spec: {name: 'Café'}}, # after-a ,\n {id: b, spec: {name: Bee}}, # after-b ,\n {id: c, spec: {name: See}}${trailing ? "," : ""} # after-c ,\n]\ncustom: exact\n`.replaceAll(
        "\n",
        eol,
      );
    const removed = ["a", "b", "c"]
      .filter((_, index) => remove & (1 << index))
      .map((id) => `persons/${id}`);
    const additions = add ? [{ id: "d", spec: { name: "Dee" } }] : [];
    const edits = patchSourceSequence(raw, "persons", additions, removed);
    const written = decodeSource(
      checkEdits(raw, edits, [...removed, ...(add ? ["persons/+"] : [])]),
    );
    expect(inspectSourceSyntax(written).value.persons).toEqual([
      ...[
        { id: "a", spec: { name: "Café" } },
        { id: "b", spec: { name: "Bee" } },
        { id: "c", spec: { name: "See" } },
      ].filter((_, index) => !(remove & (1 << index))),
      ...additions,
    ]);
    for (const comment of ["# after-a ,", "# after-b ,", "# after-c ,"])
      expect(written).toContain(comment);
    expect(written).toContain(`custom: exact${eol}`);
    if (!remove && !add) expect(edits).toEqual([]);
  },
);

test.each(["{foo: bar,}", "{foo: bar # not the comma ,\n,}"])(
  "single flow-map entry deletion includes the real trailing delimiter: %s",
  (raw) => {
    const patched = patchSourceFields(raw, { foo: undefined });
    expect(inspectSourceSyntax(decodeSource(patched.bytes)).value).toEqual({});
    expect(checkEdits(raw, patched.edits, ["foo"])).toEqual(patched.bytes);
    const inspected = inspectSourceSyntax(raw);
    expect(inspected.fields.get("foo")!.entry!.end).toBe(
      encodeSource(raw.slice(0, raw.lastIndexOf(",") + 1)).length,
    );
  },
);

test("JSON retains strict comma grammar and flow edits stay replayable", () => {
  const raw = '{"a":1,"b":[1,2],"c":3}';
  const result = patchSourceFields(raw, { a: undefined, c: undefined, d: 4 }, true);
  expect(JSON.parse(decodeSource(result.bytes))).toEqual({ b: [1, 2], d: 4 });
  expect(replaySourceByteEdits(encodeSource(raw), result.edits)).toEqual(result.bytes);
  for (const invalid of ['{"a":1,}', '{"a":1,,"b":2}', '{"a":1,"a":2}'])
    expect(() => patchSourceFields(invalid, { d: 4 }, true)).toThrow();
  for (const invalid of ["{a: 1,, b: 2}", "{a: 1, a: 2}", "{a: &x 1, b: *x}"])
    expect(() => patchSourceFields(invalid, { d: 4 })).toThrow();
});

test("sequence delimiters after comments retain quoted commas, BOM and unrelated fields", () => {
  const raw =
    "\uFEFFpersons: [{id: a, spec: {name: 'A,da'}} # comment ,\r\n , {id: b, spec: {name: Bee}},]\r\ncustom: exact\r\n";
  for (const removed of [["persons/a"], ["persons/b"], ["persons/a", "persons/b"]]) {
    const edits = patchSourceSequence(
      raw,
      "persons",
      [{ id: "c", spec: { name: "See" } }],
      removed,
    );
    const written = decodeSource(checkEdits(raw, edits, [...removed, "persons/+"]));
    expect(inspectSourceSyntax(written).value.persons).toEqual([
      ...[
        { id: "a", spec: { name: "A,da" } },
        { id: "b", spec: { name: "Bee" } },
      ].filter((person) => !removed.includes(`persons/${person.id}`)),
      { id: "c", spec: { name: "See" } },
    ]);
    expect(written.startsWith("\uFEFF")).toBe(true);
    expect(written).toContain("# comment ,\r\n");
    expect(written).toContain("custom: exact\r\n");
  }
});

test("empty and nested multiline flow insertions retain their valid closing-line anchors", () => {
  for (const raw of ["{}", "{ # keep ,\n}", "outer:\n  inner: {foo: bar, # keep ,\n  }\n"]) {
    const prefix = raw.startsWith("outer:") ? "outer/inner/" : "";
    const result = patchSourceFields(raw, { [`${prefix}new`]: "value" });
    expect(checkEdits(raw, result.edits, [`${prefix}+`])).toEqual(result.bytes);
    expect(inspectSourceSyntax(decodeSource(result.bytes)).values.get(`${prefix}new`)).toBe(
      "value",
    );
  }
  const raw = "persons: [ # keep ,\n]\n";
  const edits = patchSourceSequence(raw, "persons", [{ id: "a", spec: { name: "Ada" } }], []);
  expect(
    inspectSourceSyntax(decodeSource(checkEdits(raw, edits, ["persons/+"]))).value.persons,
  ).toEqual([{ id: "a", spec: { name: "Ada" } }]);
});

test("flow entry authority cannot authorize sibling bytes or a missing insertion anchor", () => {
  const raw = "{a: 1, b: 2,}";
  const syntax = inspectSourceSyntax(raw);
  const base = file("config.yaml", raw);
  const provenance = {
    ...base,
    sha256: sourceHash(base.bytes),
    insertion: syntax.insertion,
    fields: [...syntax.fields.values()],
  };
  const admitted = { ...provenance, fields: [syntax.fields.get("a")!] };
  const sibling = syntax.fields.get("b")!.value!;
  expect(() =>
    verifySharedEdits(base, provenance, admitted, [
      {
        ...sibling,
        selector: "a",
        oldSha256: sourceHash(base.bytes.slice(sibling.start, sibling.end)),
        replacement: encodeSource("3"),
      },
    ]),
  ).toThrow();
  expect(() =>
    verifySharedEdits(base, provenance, admitted, patchSourceFields(raw, { c: 3 }).edits),
  ).toThrow();
  expect(() =>
    replaySourceByteEdits(
      encodeSource(raw.replace("1", "9")),
      patchSourceFields(raw, { a: undefined }).edits,
    ),
  ).toThrow();
});

test("unidentified legacy flow records stay inspectable but cannot acquire guessed record authority", () => {
  const raw = "persons: [{name: Legacy},]\ntitle: Original\n";
  expect(decodeSource(patchSourceFields(raw, { title: "Edited" }).bytes)).toBe(
    'persons: [{name: Legacy},]\ntitle: "Edited"\n',
  );
  expect(() => patchSourceSequence(raw, "persons", [{ id: "new" }], [])).toThrow(
    "Ambiguous flow sequence identity",
  );
});

test.each(["? ", "!!str ", "&key ", "? !!str &key "])(
  "flow map deletion owns the complete %j key prefix",
  (prefix) => {
    for (const { eol, trailing, add, remove } of cases) {
      const keys = ["a", "b", "c"];
      const items = keys.map((key) => `${prefix.replace("&key", `&key-${key}`)}${key}: ${key}`);
      const raw = `{${items.join(`, # keep ,${eol} `)}${trailing ? "," : ""}}`;
      const selected = keys.filter((_, index) => remove & (1 << index));
      const updates = Object.fromEntries(selected.map((key) => [key, undefined]));
      const result = patchSourceFields(raw, { ...updates, ...(add ? { d: "new" } : {}) });
      const written = decodeSource(result.bytes);
      expect(inspectSourceSyntax(written).value).toEqual({
        ...Object.fromEntries(
          keys.filter((key) => !selected.includes(key)).map((key) => [key, key]),
        ),
        ...(add ? { d: "new" } : {}),
      });
      expect(checkEdits(raw, result.edits, [...selected, ...(add ? ["+"] : [])])).toEqual(
        result.bytes,
      );
      expect(written.match(/# keep ,/g)).toHaveLength(2);
      for (const [index, key] of keys.entries())
        if (!selected.includes(key)) expect(written).toContain(items[index]);
    }
  },
);

test.each(["&record ", "!!map ", "!!map &record "])(
  "flow sequence deletion owns the complete %j item prefix",
  (prefix) => {
    for (const { eol, trailing, add, remove } of cases) {
      const ids = ["a", "b", "c"];
      const items = ids.map(
        (id) => `${prefix.replace("&record", `&record-${id}`)}{id: ${id}, spec: {name: ${id}}}`,
      );
      const raw = `persons: [${items.join(`, # keep ,${eol} `)}${trailing ? "," : ""}]${eol}`;
      const selected = ids.filter((_, index) => remove & (1 << index)).map((id) => `persons/${id}`);
      const additions = add ? [{ id: "d", spec: { name: "new" } }] : [];
      const edits = patchSourceSequence(raw, "persons", additions, selected);
      const written = decodeSource(
        checkEdits(raw, edits, [...selected, ...(add ? ["persons/+"] : [])]),
      );
      expect(inspectSourceSyntax(written).value.persons).toEqual([
        ...ids
          .filter((id) => !selected.includes(`persons/${id}`))
          .map((id) => ({ id, spec: { name: id } })),
        ...additions,
      ]);
      expect(written.match(/# keep ,/g)).toHaveLength(2);
      for (const [index, id] of ids.entries())
        if (!selected.includes(`persons/${id}`)) expect(written).toContain(items[index]);
    }
  },
);

function authority(project: SourceProject): SourceWriteAuthority {
  return {
    resources: project.compilation.resources.map((resource) => `${resource.type}/${resource.name}`),
    exclusive: project.documents
      .filter((document) => document.path.endsWith(".md"))
      .map(({ path, sha256, mode }) => ({ path, sha256, mode })),
    shared: project.configurations.filter((config) => config.path !== ".topik.yaml"),
    create: [],
  };
}
const projectFor = (metadata: string, config = "") =>
  readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: flow\nsources: [{kind: collection, config: docs/collection.yaml}, # tail ,\n]\n",
      ),
      file("docs/collection.yaml", `id: docs\ntitle: Docs\nsourceVersion: 1\n${config}`),
      file("docs/home.md", `---\n${metadata}\n---\n# Home\n\nExact body.\n`),
    ],
  });

test("deleting explicitly keyed Guide metadata cannot change an unknown field", async () => {
  const project = await projectFor("{custom: keep, ? description: remove}");
  const desired = structuredClone(project.compilation.resources);
  const guide = desired.find((resource): resource is Guide => resource.type === "Guide")!;
  delete guide.spec.description;
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: `Guide/${guide.name}` }],
    authority: authority(project),
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const written = decodeSource(result.plan.changes[0].candidate!.bytes);
  expect(written).toContain("{custom: keep ");
  expect(written).not.toContain("?");
  expect(inspectSourceSyntax(written.split("\n")[1]).value).toEqual({ custom: "keep" });
});

test.each(["{id: home,}", "{id: home, labels: {foo: bar,},}"])(
  "flow frontmatter accepts metadata edits: %s",
  async (metadata) => {
    const project = await projectFor(metadata);
    const desired = structuredClone(project.compilation.resources);
    const guide = desired.find((resource): resource is Guide => resource.type === "Guide")!;
    guide.spec.title = "Edited";
    if (guide.labels) guide.labels = {};
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [{ kind: "update", resource: "Guide/home" }],
      authority: authority(project),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.plan.candidate.compilation.resources).toEqual(desired);
      expect(decodeSource(result.plan.changes[0].candidate!.bytes)).toContain(
        "# Home\n\nExact body.\n",
      );
    }
  },
);

test.each(["add", "delete", "replace"])(
  "Person %s uses only admitted flow entry and insertion evidence",
  async (change) => {
    const project = await projectFor(
      "id: home",
      "persons: [{id: alice, spec: {name: Alice}}, # keep ,\n]\ncustom: exact\n",
    );
    const desired = structuredClone(project.compilation.resources).filter(
      (resource) => change === "add" || resource.type !== "Person",
    );
    if (change !== "delete")
      desired.push({
        apiVersion: "v1",
        type: "Person",
        name: "bob",
        spec: { name: "Bob", email: null, bio: null },
      });
    const admitted = authority(project);
    const request = {
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [
        ...(change === "add" ? [] : [{ kind: "delete" as const, resource: "Person/alice" }]),
        ...(change === "delete"
          ? []
          : [{ kind: "create" as const, resource: "Person/bob", config: "docs/collection.yaml" }]),
      ],
      authority: {
        ...admitted,
        resources: [...admitted.resources, "Person/bob"],
        shared: admitted.shared.map((config) => ({
          ...config,
          fields: config.fields.filter(
            (field) =>
              (change !== "add" && field.selector === "persons/alice") ||
              (change !== "delete" && field.selector === "persons/+"),
          ),
        })),
      },
    };
    const result = await planSourceUpdates(request);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const changed = result.plan.changes.find((entry) => entry.path === "docs/collection.yaml")!;
    expect(
      replaySourceByteEdits(
        project.tree.find((entry) => entry.path === changed.path)!.bytes,
        changed.sharedEdits!,
      ),
    ).toEqual(changed.candidate!.bytes);
    expect(decodeSource(changed.candidate!.bytes)).toContain("# keep ,\n");
    expect(result.plan.candidate.compilation.resources).toEqual(desired);
    const denied = await planSourceUpdates({
      ...request,
      authority: {
        ...request.authority,
        shared: admitted.shared.map((config) => ({ ...config, fields: [] })),
      },
    });
    expect(denied).toMatchObject({ ok: false, diagnostics: [{ code: "shared-scope-denied" }] });
    if (change !== "add") {
      const stale = structuredClone(request.authority);
      stale.shared[0].fields.find((field) => field.selector === "persons/alice")!.entry!.end--;
      expect(await planSourceUpdates({ ...request, authority: stale })).toMatchObject({
        ok: false,
        diagnostics: [{ code: "shared-authority-stale" }],
      });
    }
  },
);

test("manifest append reuses a trailing comma with only sources/+ authority", async () => {
  const project = await projectFor("id: home");
  const manifest = project.configurations.find((config) => config.path === ".topik.yaml")!;
  const guide: Guide = {
    apiVersion: "v1",
    type: "Guide",
    name: "new-guide",
    spec: { title: "New", slug: "new", content: { format: "topik", value: "# New\n" } },
  };
  const request = {
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    source: { kind: "collection" as const, config: "new/collection.yaml", id: "new", title: "New" },
    resources: [guide],
    createPaths: ["new/collection.yaml", "new/new.md"],
    manifestAuthority: {
      ...manifest,
      fields: manifest.fields.filter((field) => field.selector === "sources/+"),
    },
  };
  const result = await addSourceToProject(request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const changed = result.plan.changes.find((entry) => entry.path === ".topik.yaml")!;
  expect(decodeSource(changed.candidate!.bytes)).toContain(
    "{kind: collection, config: docs/collection.yaml}, # tail ,\n",
  );
  expect(
    replaySourceByteEdits(
      project.tree.find((entry) => entry.path === ".topik.yaml")!.bytes,
      changed.sharedEdits!,
    ),
  ).toEqual(changed.candidate!.bytes);
  expect(result.plan.candidate.compilation.resources).toContainEqual(guide);
  expect(
    await addSourceToProject({ ...request, manifestAuthority: { ...manifest, fields: [] } }),
  ).toMatchObject({ ok: false, diagnostics: [{ code: "shared-scope-denied" }] });
});
