import { expect, test } from "vite-plus/test";
import { planSourceUpdates, verifySharedEdits } from "./plan";
import { readSourceProject } from "./project";
import {
  decodeSource,
  encodeSource,
  inspectSourceSyntax,
  patchSourceFields,
  replaySourceByteEdits,
  sourceHash,
} from "./syntax";

const prefixes = ["", "!!str ", "&key ", "? !!str &key "];
const file = (path: string, raw: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(raw),
});
const firstField = (prefix: string, key: string, value: string, indent = "    ") =>
  prefix.startsWith("?") ? `${prefix}${key}\n${indent}: ${value}` : `${prefix}${key}: ${value}`;

// The sequence indicator and all surviving sibling bytes are outside the deleted field.
test.each(prefixes)(
  "first compact-map deletion preserves narrow byte authority for %j",
  (prefix) => {
    for (const eol of ["\n", "\r\n"]) {
      for (const nested of [false, true]) {
        const indent = nested ? "      " : "    ";
        const head = `\uFEFF# Café\nrecords:\n  - ${nested ? "- " : ""}`;
        const entry = `${firstField(prefix, "remove", "old # selected", indent)}\n`;
        const tail = `${indent}# retain sibling comment\n${indent}keep: exact\ncustom: unchanged\n`;
        const raw = (head + entry + tail).replaceAll("\n", eol);
        const selector = nested ? "records/0/0/remove" : "records/0/remove";
        const original = inspectSourceSyntax(raw);
        const base = file("config.yaml", raw);
        const evidence = {
          ...base,
          sha256: sourceHash(base.bytes),
          fields: [...original.fields.values()],
          insertion: original.insertion,
        };
        const scope = {
          ...evidence,
          fields: evidence.fields.filter((field) => field.selector === selector),
        };
        const result = patchSourceFields(raw, { [selector]: undefined });
        expect(decodeSource(result.bytes)).toBe((head + "\n" + tail).replaceAll("\n", eol));
        expect(result.edits).toHaveLength(1);
        const edit = result.edits[0];
        expect(edit).toMatchObject({
          ...scope.fields[0].entry,
          selector,
          replacement: encodeSource(eol),
        });
        expect(decodeSource(base.bytes.slice(edit.start, edit.end))).toBe(
          entry.replaceAll("\n", eol),
        );
        expect(() => verifySharedEdits(base, evidence, scope, result.edits)).not.toThrow();
        expect(() =>
          verifySharedEdits(base, evidence, { ...scope, fields: [] }, result.edits),
        ).toThrow();
        expect(replaySourceByteEdits(base.bytes, result.edits)).toEqual(result.bytes);
        expect(patchSourceFields(decodeSource(result.bytes), {}).bytes).toEqual(result.bytes);
      }
    }
  },
);

test("compact-map removal retains an empty map or replacement fields without taking the dash", () => {
  const raw = "records:\n  - remove: old\n    second: old\ncustom: exact\n";
  const removed = { "records/0/remove": undefined, "records/0/second": undefined };
  expect(decodeSource(patchSourceFields(raw, removed).bytes)).toBe(
    "records:\n  - {}\ncustom: exact\n",
  );
  expect(decodeSource(patchSourceFields(raw, { ...removed, "records/0/added": "new" }).bytes)).toBe(
    'records:\n  - \n    added: "new"\ncustom: exact\n',
  );
  const separate = "records:\n  - # keep dash comment\n    remove: old\n    keep: exact\n";
  expect(decodeSource(patchSourceFields(separate, { "records/0/remove": undefined }).bytes)).toBe(
    "records:\n  - # keep dash comment\n    keep: exact\n",
  );
  const block = "persons:\n  - labels:\n      role: author\n    id: ada\n    spec: {name: Ada}\n";
  expect(decodeSource(patchSourceFields(block, { "persons/ada/labels": undefined }).bytes)).toBe(
    "persons:\n  - \n    id: ada\n    spec: {name: Ada}\n",
  );
  expect(
    decodeSource(
      patchSourceFields("records:\n  - remove: old", {
        "records/0/remove": undefined,
        "records/0/added": "new",
      }).bytes,
    ),
  ).toBe('records:\n  - \n    added: "new"\n');
});

test.each(["person", "module"] as const)(
  "%s can remove its first optional record field using only that field's authority",
  async (kind) => {
    for (const prefix of prefixes) {
      for (const eol of ["\n", "\r\n"]) {
        for (const siblingComment of [false, true]) {
          const key = kind === "person" ? "Person/ada" : "CourseModule/basics";
          const selector = kind === "person" ? "persons/ada/labels" : "modules/basics/description";
          const head =
            kind === "person"
              ? "\uFEFFid: docs\ntitle: Docs\nsourceVersion: 1\npersons:\n  - "
              : "\uFEFFid: docs\ntitle: Docs\nslug: docs\nsourceVersion: 1\nmodules:\n  - ";
          const entry = `${firstField(prefix, kind === "person" ? "labels" : "description", kind === "person" ? "{role: author} # selected" : "Remove # selected")}\n`;
          const tail =
            (siblingComment ? "    # keep Café\n" : "") +
            (kind === "person"
              ? "    id: ada\n    spec: {name: Ada}\n  - id: bob\n    spec: {name: Bob}\ncustom: exact\n"
              : "    id: basics\n    title: Basics\n    slug: basics\n    order: 0\n    pages: []\n  - id: next\n    title: Next\n    slug: next\n    order: 1\n    pages: []\ncustom: exact\n");
          const raw = (head + entry + tail).replaceAll("\n", eol);
          const project = await readSourceProject({
            tree: [
              file(
                ".topik.yaml",
                `version: 1\nnamespace: audit\nsources: [{kind: ${kind === "person" ? "collection" : "course"}, config: config.yaml}]\n`,
              ),
              file("config.yaml", raw),
              ...(kind === "person"
                ? [file("home.md", "---\nid: home\ntitle: Home\nauthors: [ada]\n---\n# Home\n")]
                : []),
            ],
          });
          const original = structuredClone(project.tree);
          const desired = structuredClone(project.compilation.resources);
          const resource = desired.find((resource) => `${resource.type}/${resource.name}` === key)!;
          if (resource.type === "Person") delete resource.labels;
          else if (resource.type === "CourseModule") delete resource.spec.description;
          else throw new Error("Expected fixture resource");
          const config = project.configurations.find((config) => config.path === "config.yaml")!;
          const shared = {
            ...config,
            fields: config.fields.filter((field) => field.selector === selector),
          };
          const request = {
            project,
            expectedTreeDigest: project.treeDigest,
            packageCohort: "a".repeat(64),
            desiredResources: desired,
            operations: [{ kind: "update" as const, resource: key }],
            authority: {
              resources: kind === "person" ? [key, "Guide/home"] : [key],
              exclusive: [],
              shared: [shared],
              create: [],
            },
          };
          const result = await planSourceUpdates(request);
          expect(result.ok, JSON.stringify(result)).toBe(true);
          if (!result.ok) continue;
          expect(project.tree).toEqual(original);
          expect(result.plan.changes).toHaveLength(1);
          const change = result.plan.changes[0];
          expect(change.path).toBe("config.yaml");
          expect(decodeSource(change.candidate!.bytes)).toBe(
            (head + "\n" + tail).replaceAll("\n", eol),
          );
          expect(change.sharedEdits).toHaveLength(1);
          expect(replaySourceByteEdits(encodeSource(raw), change.sharedEdits!)).toEqual(
            change.candidate!.bytes,
          );
          expect(result.plan.candidate.compilation.resources).toEqual(desired);
          for (const originalFile of original.filter((file) => file.path !== "config.yaml"))
            expect(
              result.plan.candidate.tree.find((file) => file.path === originalFile.path),
            ).toEqual(originalFile);
          const denied = await planSourceUpdates({
            ...request,
            authority: { ...request.authority, shared: [{ ...shared, fields: [] }] },
          });
          expect(denied).toMatchObject({
            ok: false,
            diagnostics: [{ code: "shared-scope-denied" }],
          });
          const stale = await planSourceUpdates({
            ...request,
            authority: { ...request.authority, shared: [{ ...shared, sha256: "b".repeat(64) }] },
          });
          expect(stale).toMatchObject({
            ok: false,
            diagnostics: [{ code: "shared-authority-required" }],
          });
          const noop = await planSourceUpdates({
            project: result.plan.candidate,
            expectedTreeDigest: result.plan.candidateTreeDigest,
            packageCohort: "a".repeat(64),
            desiredResources: desired,
            operations: [],
            authority: { resources: [], exclusive: [], shared: [], create: [] },
          });
          expect(noop.ok && noop.plan.changes).toEqual([]);
        }
      }
    }
  },
);
