import { expect, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import { readSourceProject, sourceMarkdownSections, type SourceProject } from "./project";
import { planSourceUpdates, type SourceWriteAuthority } from "./plan";
import {
  decodeSource,
  encodeSource,
  inspectSourceSyntax,
  patchFrontmatterFields,
  replaySourceByteEdits,
} from "./syntax";

const cohort = "a".repeat(64);
const file = (path: string, raw: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(raw),
});
const authority = (project: SourceProject): SourceWriteAuthority => ({
  resources: project.documents.map((document) => document.resource),
  exclusive: project.documents.map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
  shared: [],
  create: [],
});
const projectFor = (raw: string) =>
  readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: test\nsources: [{kind: collection, config: collection.yaml}]\n",
      ),
      file("collection.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\n"),
      file("post.md", raw),
    ],
  });

const emptyHeaders = [
  "---\n---\n",
  "---\n\n---\n",
  "---\n# keep Café\n---\n",
  "---\n  # keep Café\n\n# tail\n---\n",
];
test.each(emptyHeaders.flatMap((header) => ["\n", "\r\n"].map((eol) => ({ header, eol }))))(
  "empty frontmatter supports title insertion and exact no-op: $header with $eol",
  async ({ header, eol }) => {
    const raw = (header + "# Original\n\nExact **body**.\n").replaceAll("\n", eol);
    const project = await projectFor(raw);
    expect(sourceMarkdownSections(encodeSource(raw)).body).toBe(
      "# Original\n\nExact **body**.\n".replaceAll("\n", eol),
    );
    const guide = project.compilation.resources.find(
      (resource): resource is Guide => resource.type === "Guide",
    )!;
    expect(guide.spec.title).toBe("Original");
    const request = {
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: project.compilation.resources,
      operations: [],
      authority: authority(project),
    };
    const noOp = await planSourceUpdates(request);
    expect(noOp.ok && noOp.plan.changes).toEqual([]);
    const desired = structuredClone(project.compilation.resources);
    (desired.find((resource) => resource.type === "Guide") as Guide).spec.title = "Edited";
    const result = await planSourceUpdates({
      ...request,
      desiredResources: desired,
      operations: [{ kind: "update", resource: `Guide/${guide.name}` }],
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const written = result.plan.candidate.tree.find((entry) => entry.path === "post.md")!.bytes;
    const sections = sourceMarkdownSections(written);
    expect(sections.body).toBe(sourceMarkdownSections(encodeSource(raw)).body);
    expect(decodeSource(written)).toContain('"title": "Edited"');
    const priorSections = sourceMarkdownSections(encodeSource(raw));
    expect(sections.frontmatter).toContain(priorSections.frontmatter!);
    expect(project.documents[0].fields).toContainEqual({
      selector: "+",
      insertion: priorSections.frontmatterRange!.end,
    });
    if (eol === "\r\n") expect(decodeSource(written)).not.toMatch(/(?<!\r)\n/u);
    expect(result.plan.candidate.compilation.resources).toEqual(desired);
    expect(
      await planSourceUpdates({
        ...request,
        desiredResources: desired,
        operations: [{ kind: "update", resource: `Guide/${guide.name}` }],
      }),
    ).toEqual(result);
    const repeat = await planSourceUpdates({
      ...request,
      project: result.plan.candidate,
      expectedTreeDigest: result.plan.candidateTreeDigest,
      desiredResources: desired,
      authority: authority(result.plan.candidate),
    });
    expect(repeat.ok && repeat.plan.changes).toEqual([]);
  },
);

test.each(["", "# comment\n", "null\n", "[]\n", "title: first\ntitle: second\n"])(
  "configuration mapping validation stays strict for %s",
  (raw) => {
    expect(() => inspectSourceSyntax(raw)).toThrow();
  },
);

test.each(["\n", "\r\n"])("empty metadata insertion replays exact UTF-8 ranges with %j", (eol) => {
  const raw = `# Café${eol}  # tail`;
  const result = patchFrontmatterFields(raw, { title: "Edited", description: undefined }, eol);
  expect(result.edits).toMatchObject([
    { start: encodeSource(raw).length, end: encodeSource(raw).length },
  ]);
  expect(replaySourceByteEdits(encodeSource(raw), result.edits)).toEqual(result.bytes);
  expect(decodeSource(result.bytes)).toBe(`${raw}${eol}"title": "Edited"${eol}`);
  expect(patchFrontmatterFields(raw, { description: undefined }, eol)).toEqual({
    bytes: encodeSource(raw),
    edits: [],
  });
  expect(() => patchFrontmatterFields("null", { title: "Edited" }, eol)).toThrow();
  expect(() => patchFrontmatterFields(raw, { "labels/new": "value" }, eol)).toThrow();
});
