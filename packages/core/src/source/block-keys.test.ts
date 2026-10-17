import { expect, test } from "vite-plus/test";
import { planSourceUpdates } from "./plan";
import { readSourceProject } from "./project";
import {
  decodeSource,
  encodeSource,
  inspectSourceSyntax,
  patchSourceFields,
  replaySourceByteEdits,
} from "./syntax";

const spellings = ["!!str key", "&key-name key", "? key\n", "? !!str &key-name key\n"];

test.each(spellings)("block-map insertion uses the mapping indentation after %j", (spelling) => {
  for (const eol of ["\n", "\r\n"]) {
    for (const shape of ["root", "nested", "sequence"] as const) {
      const entry = `${spelling}: value\n`;
      const raw = (
        shape === "root"
          ? `\uFEFF${entry}custom: exact\n`
          : shape === "nested"
            ? `labels:\n  ${entry.replaceAll("\n", "\n  ")}custom: exact\n`
            : `persons:\n  - ${entry.replaceAll("key", "id").replaceAll("\n", "\n    ")}spec: {name: Ada}\n`
      ).replaceAll("\n", eol);
      const prefix = shape === "root" ? "" : shape === "nested" ? "labels/" : "persons/value/";
      const result = patchSourceFields(raw, { [`${prefix}added`]: "new" });
      const value = inspectSourceSyntax(decodeSource(result.bytes)).value;
      expect(value).toMatchObject(
        shape === "root"
          ? { added: "new" }
          : shape === "nested"
            ? { labels: { added: "new" } }
            : { persons: [{ added: "new" }] },
      );
      expect(decodeSource(result.bytes)).toContain(
        shape === "sequence" ? "spec: {name: Ada}" : "custom: exact",
      );

      expect(replaySourceByteEdits(encodeSource(raw), result.edits)).toEqual(result.bytes);
    }
  }
});

test.each(spellings)(
  "block-map deletion removes the complete %j key without changing its sibling",
  (spelling) => {
    for (const eol of ["\n", "\r\n"]) {
      const raw = `\uFEFF# keep Café\n${spelling}: value\ncustom: exact\n`.replaceAll("\n", eol);
      const result = patchSourceFields(raw, { key: undefined });
      expect(decodeSource(result.bytes)).toBe(`\uFEFF# keep Café${eol}custom: exact${eol}`);
      expect(replaySourceByteEdits(encodeSource(raw), result.edits)).toEqual(result.bytes);

      const nested =
        `labels:\n  ${spelling.replaceAll("\n", "\n  ")}: value\ncustom: exact\n`.replaceAll(
          "\n",
          eol,
        );
      const empty = patchSourceFields(nested, { "labels/key": undefined });
      expect(decodeSource(empty.bytes)).toBe(`labels:${eol}  {}${eol}custom: exact${eol}`);
    }
  },
);

const file = (path: string, raw: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(raw),
});

test.each(["guide", "wiki"] as const)(
  "%s metadata changes preserve block-key syntax and unrelated bytes",
  async (kind) => {
    for (const first of ["!!str title: Home", "? title\n: Home"]) {
      const config = kind === "guide" ? "collection.yaml" : "wiki.yaml";
      const project = await readSourceProject({
        tree: [
          file(
            ".topik.yaml",
            `version: 1\nnamespace: audit\nsources: [{kind: ${kind === "guide" ? "collection" : "wiki"}, config: ${config}}]\n`,
          ),
          file(
            config,
            kind === "guide"
              ? "id: docs\ntitle: Docs\nsourceVersion: 1\n"
              : `${first}\nid: docs\nsourceVersion: 1\nnavigation: [home]\ncustom: exact\n`,
          ),
          file("home.md", `---\n${first}\n? description\n: remove\ncustom: exact\n---\n# Home\n`),
        ],
      });
      const desired = structuredClone(project.compilation.resources);
      const resource = desired.find(
        (entry) => entry.type === (kind === "guide" ? "Guide" : "Wiki"),
      )!;
      if (resource.type !== "Guide" && resource.type !== "Wiki")
        throw new Error("Expected fixture");
      resource.labels = { author: "Ada" };
      if (kind === "guide") delete resource.spec.description;
      else resource.spec.description = "New description";
      const key = `${resource.type}/${resource.name}`;
      const configuration = project.configurations.find((entry) => entry.path === config)!;
      const result = await planSourceUpdates({
        project,
        expectedTreeDigest: project.treeDigest,
        packageCohort: "a".repeat(64),
        desiredResources: desired,
        operations: [{ kind: "update", resource: key }],
        authority: {
          resources: [key],
          exclusive: project.documents
            .filter((entry) => entry.path === "home.md")
            .map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
          shared:
            kind === "wiki"
              ? [
                  {
                    ...configuration,
                    fields: configuration.fields.filter((field) => field.selector === "+"),
                  },
                ]
              : [],
          create: [],
        },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      expect(result.plan.changes).toHaveLength(1);
      const changed = result.plan.changes[0];
      expect(changed.path).toBe(kind === "guide" ? "home.md" : config);
      const written = decodeSource(changed.candidate!.bytes);
      expect(written).toContain(first);
      expect(written).toContain("custom: exact\n");
      if (kind === "guide") {
        expect(written).not.toContain("? description");
        expect(written.endsWith("---\n# Home\n")).toBe(true);
      }
      expect(result.plan.candidate.compilation.resources).toEqual(desired);
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
  },
);
