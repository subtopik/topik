import { expect, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import { readSourceProject, sourceMarkdownSections, type SourceProject } from "./project";
import { planSourceUpdates, type SourceWriteAuthority } from "./plan";
import { parseMarkdownFrontmatter } from "../compile/shared";
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
  "---\n# keep\u2028comment\n---\n",
  "---\n# keep\u2029comment\n---\n",
  "---\n# first\r# second\n---\n",
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
  expect(() =>
    patchFrontmatterFields("# comment\rtitle: Existing", { title: "Edited" }, eol),
  ).toThrow();
});

test.each(
  ["\n", "\r\n"].flatMap((eol) =>
    ["metadata", "body", "both", "noop"].map((change) => ({ eol, change })),
  ),
)(
  "BOM frontmatter preserves identity, byte ranges and $change edits with $eol",
  async ({ eol, change }) => {
    const header =
      "\uFEFF---\nid: stable-post\ntitle: Original # Café\ncustom: untouched\n---\n".replaceAll(
        "\n",
        eol,
      );
    const body = "# Heading\n\nExact **body**.\n".replaceAll("\n", eol);
    const raw = header + body;
    const project = await projectFor(raw);
    const guide = project.compilation.resources.find(
      (resource): resource is Guide => resource.type === "Guide",
    )!;
    expect(guide.name).toBe("stable-post");
    expect(guide.spec.title).toBe("Original");
    const sections = sourceMarkdownSections(encodeSource(raw));
    expect(sections.frontmatterRange!.start).toBe(3 + 3 + eol.length);
    expect(sections.bodyRange.start).toBe(encodeSource(header).length);
    expect(sections.body).toBe(body);
    const title = project.documents[0].fields.find((field) => field.selector === "title")!;
    expect(decodeSource(encodeSource(raw).slice(title.value!.start, title.value!.end))).toBe(
      "Original",
    );
    const desired = structuredClone(project.compilation.resources);
    const updated = desired.find((resource): resource is Guide => resource.type === "Guide")!;
    if (change === "metadata" || change === "both") updated.spec.title = "Edited";
    if (change === "body" || change === "both") updated.spec.content.value += `${eol}Added.${eol}`;
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: change === "noop" ? [] : [{ kind: "update", resource: "Guide/stable-post" }],
      authority: authority(project),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const written = result.plan.candidate.tree.find((entry) => entry.path === "post.md")!.bytes;
    expect(written.slice(0, 3)).toEqual(encodeSource("\uFEFF"));
    expect(decodeSource(written).match(/---/g)).toHaveLength(2);
    expect(decodeSource(written)).toContain(`# Café${eol}custom: untouched${eol}`);
    if (change === "noop") {
      expect(written).toEqual(encodeSource(raw));
      expect(result.plan.changes).toEqual([]);
    } else if (change === "metadata") {
      expect(sourceMarkdownSections(written).body).toBe(body);
      const patched = patchFrontmatterFields(sections.frontmatter!, { title: "Edited" }, eol);
      const edits = patched.edits.map((edit) => ({
        ...edit,
        start: edit.start + sections.frontmatterRange!.start,
        end: edit.end + sections.frontmatterRange!.start,
      }));
      expect(replaySourceByteEdits(encodeSource(raw), edits)).toEqual(written);
    } else {
      expect(sourceMarkdownSections(written).body).toContain(`Added.${eol}`);
      expect(
        decodeSource(written).startsWith(
          change === "body" ? header : header.replace("title: Original", 'title: "Edited"'),
        ),
      ).toBe(true);
    }
    expect(result.plan.candidate.compilation.resources).toEqual(desired);
  },
);

test.each(["\n", "\r\n"])(
  "first metadata insertion keeps a headerless BOM at byte zero with %j",
  async (eol) => {
    const body = "# Original\n\nExact **body**.\n".replaceAll("\n", eol);
    const project = await projectFor(`\uFEFF${body}`);
    const desired = structuredClone(project.compilation.resources);
    const guide = desired.find((resource): resource is Guide => resource.type === "Guide")!;
    guide.spec.title = "Edited";
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
    const written = result.plan.candidate.tree.find((entry) => entry.path === "post.md")!.bytes;
    expect(written.slice(0, 3)).toEqual(encodeSource("\uFEFF"));
    expect(sourceMarkdownSections(written).body).toBe(body);
    expect(decodeSource(written).match(/\uFEFF/g)).toHaveLength(1);
  },
);

test.each(["title: 42", "- invalid", "title: A\ntitle: B", "title: &a A\ncustom: *a"])(
  "BOM cannot hide invalid versioned metadata: %s",
  async (metadata) => {
    for (const eol of ["\n", "\r\n"]) {
      const raw = `\uFEFF---\n${metadata}\n---\n# Body\n`.replaceAll("\n", eol);
      expect(() => parseMarkdownFrontmatter(raw, "post.md", 1)).toThrow(
        "Document frontmatter is invalid.",
      );
      await expect(projectFor(raw)).rejects.toThrow("Document frontmatter is invalid.");
    }
  },
);

test.each([undefined, 1] as const)(
  "BOM header parsing is consistent for source version %j",
  (version) => {
    for (const eol of ["\n", "\r\n"]) {
      for (const metadata of ["", "# Café", "title: Original"]) {
        const raw = `\uFEFF---${eol}${metadata}${metadata ? eol : ""}---${eol}Body${eol}`;
        const parsed = parseMarkdownFrontmatter(raw, "post.md", version);
        expect(parsed).toEqual({
          frontmatter: metadata.startsWith("title:") ? { title: "Original" } : {},
          content: `Body${eol}`,
        });
        const sections = sourceMarkdownSections(encodeSource(raw));
        expect(sections.body).toBe(parsed.content);
        expect(
          decodeSource(
            encodeSource(raw).slice(
              sections.frontmatterRange!.start,
              sections.frontmatterRange!.end,
            ),
          ),
        ).toBe(metadata);
      }
      expect(() =>
        parseMarkdownFrontmatter(`\uFEFF---${eol}title: 42${eol}---`, "post.md", version),
      ).toThrow();
    }
  },
);

test.each(
  ["", "\uFEFF"].flatMap((prefix) => ["insert", "delete"].map((change) => ({ prefix, change }))),
)(
  "single-line CRLF metadata $change retains document line endings with prefix $prefix",
  async ({ prefix, change }) => {
    const raw = `${prefix}---\r\n${change === "insert" ? "id: home" : "description: Summary"}\r\n---\r\n# Home\r\n`;
    const project = await projectFor(raw);
    const desired = structuredClone(project.compilation.resources);
    const guide = desired.find((resource): resource is Guide => resource.type === "Guide")!;
    if (change === "insert") guide.spec.title = "Edited";
    else delete guide.spec.description;
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
    expect(written).toBe(
      `${prefix}---\r\n${change === "insert" ? 'id: home\r\ntitle: "Edited"' : "{}"}\r\n\r\n---\r\n# Home\r\n`,
    );
  },
);
