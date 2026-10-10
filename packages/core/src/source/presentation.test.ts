import { expect, test } from "vite-plus/test";
import {
  FORMAT_VERSION,
  TOPIK_CONTENT_SCHEMA_VERSION,
  extractTopikAssetOccurrences,
  parseDocument,
  sameDocumentMeaning,
  writeDocument,
} from "@topik/content";
import type { Guide } from "@topik/schema/guide/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import { validateTopikMaterializationRecord } from "../assets/identity";
import {
  readSourceProject,
  SOURCE_WRITER_DESCRIPTOR,
  type SourceProject,
  type SourceTreeFile,
} from "./project";
import { planSourceUpdates, type SourceWriteAuthority } from "./plan";
import { addSourceToProject } from "./initialize";
import { decodeSource, encodeSource } from "./syntax";

const cohort = "a".repeat(64);
const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const file = (path: string, source: string, mode: SourceTreeFile["mode"] = "100644") => ({
  path,
  mode,
  bytes: encodeSource(source),
});

type AuthoringNode = {
  type: string;
  children?: AuthoringNode[];
  options?: Record<string, unknown>;
  opaqueMetaSuffix?: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  template?: unknown;
};

function presented(source: string) {
  const parsed = parseDocument(source);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (!parsed.ok) throw new Error("Expected admitted authoring source");
  const nodes: AuthoringNode[] = [];
  function visit(node: AuthoringNode) {
    if (node.type === "topikCodePresentation") nodes.push(node);
    node.children?.forEach(visit);
  }
  visit(parsed.document as unknown as AuthoringNode);
  return { document: parsed.document, nodes };
}

const body = [
  "# Original",
  "",
  '```ts filename="missing.png" title="A &#38;amp; label" lines startLine=10 highlight="1,2-3,2" focus="2-3" collapse="3-4" wrap=false added="2" removed="3"  legacy&#38;amp; &#92; &#96;',
  "\tconst first = 1;  ",
  "  + source marker",
  "- source marker",
  "",
  "```",
  "",
  "{% if $showInstall %}",
  "{% template code %}",
  '```sh title="Install" highlight="1-2"  untouched',
  "npm install {% $package.name %}",
  "![Code only](missing.png)",
  "```",
  "{% /template code %}",
  "{% else /%}",
  '~~~text title="Alternative" wrap',
  "{% $unprovided.name %}",
  "[Code only](missing.png)",
  "~~~",
  "",
  "![Branch image](hero.png)",
  "{% /if %}",
  "",
  "{% codeGroup %}",
  '{% codeTab title="Examples" %}',
  "```text legacy-note",
  "![Ordinary code](missing.png)",
  "```",
  "",
  '```unknown-text filename="asset:missing" title="Last example"',
  "\tlast  ",
  "```",
  "{% /codeTab %}",
  "{% /codeGroup %}",
  "",
  "![Actual image](hero.png)",
  "",
].join("\r\n");

async function fixture(kind: "collection" | "wiki") {
  const directory = kind === "collection" ? "guides" : "docs";
  const config = `${directory}/${kind === "collection" ? "collection" : "wiki"}.yaml`;
  const original = `---\r\nid: stable\r\ntitle: Original # keep\r\ncustom: exact\r\n---\r\n${body}${kind === "wiki" ? "[Sibling](sibling.md?view=full#sibling)\r\n" : ""}`;
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        `version: 1\nnamespace: example/presentation\nsources: [{kind: ${kind}, config: ${config}}]\n`,
      ),
      file(
        config,
        kind === "collection"
          ? "id: examples\ntitle: Examples\nsourceVersion: 1\n"
          : "id: handbook\ntitle: Handbook\nsourceVersion: 1\nnavigation: [page, sibling]\n",
      ),
      file(`${directory}/page.md`, original, "100755"),
      file(`${directory}/sibling.md`, "---\nid: sibling\n---\n# Sibling\n"),
      { path: `${directory}/hero.png`, mode: "100644", bytes: png },
      file("README.md", "Unowned exact bytes\r\n", "100755"),
    ],
  });
  const resource = `${kind === "collection" ? "Guide" : "WikiPage"}/stable`;
  const document = project.documents.find((document) => document.resource === resource)!;
  const authority: SourceWriteAuthority = {
    resources: [resource],
    exclusive: [{ path: document.path, sha256: document.sha256, mode: document.mode }],
    shared: [],
    create: [],
  };
  return { project, resource, authority, original, path: document.path };
}

function content(project: SourceProject, resource: string): Guide | WikiPage {
  return project.compilation.resources.find(
    (entry): entry is Guide | WikiPage => `${entry.type}/${entry.name}` === resource,
  )!;
}

test.each(["collection", "wiki"] as const)(
  "%s compiles presentation/template source in every branch without inferring code assets",
  async (kind) => {
    const { project, resource } = await fixture(kind);
    const stored = content(project, resource).spec.content.value;
    const { nodes } = presented(stored);
    expect(nodes).toHaveLength(4);
    expect(nodes[0].options).toEqual({
      filename: "missing.png",
      title: "A &amp; label",
      lineNumbers: true,
      startLine: 10,
      highlight: [[1, 3]],
      focus: [[2, 3]],
      collapse: [[3, 4]],
      wrap: false,
      added: [[2, 2]],
      removed: [[3, 3]],
    });
    expect(nodes[0].opaqueMetaSuffix).toBe("  legacy&amp; \\ `");
    expect(nodes[0].children?.[0]).toMatchObject({
      type: "code",
      lang: "ts",
      value: "\tconst first = 1;  \n  + source marker\n- source marker\n",
    });
    expect(nodes[1].children?.[0].type).toBe("topikCodeTemplate");
    expect(stored).toContain("npm install {% $package.name %}");
    expect(stored).toContain("{% $unprovided.name %}");
    expect(stored).toContain("legacy-note");
    const occurrences = extractTopikAssetOccurrences(stored);
    expect(occurrences).toHaveLength(2);
    expect(new Set(occurrences.map((occurrence) => occurrence.reference)).size).toBe(1);
    expect(project.compilation.semantic.assetNames).toHaveLength(1);
    expect(project.compilation.semantic.references).toHaveLength(2);
    expect(project.compilation.semantic.descriptor).toBe("topik-asset-semantic-v1");
    expect(
      validateTopikMaterializationRecord(
        project.compilation.materialization,
        project.compilation.resources,
        project.compilation.semantic,
      ).ok,
    ).toBe(true);
  },
);

test.each(["collection", "wiki"] as const)(
  "%s frontmatter edit preserves exact presented body and all sibling bytes through fresh import",
  async (kind) => {
    const { project, resource, authority, original, path } = await fixture(kind);
    const desired = structuredClone(project.compilation.resources);
    desired.find(
      (entry): entry is Guide | WikiPage => `${entry.type}/${entry.name}` === resource,
    )!.spec.title = "Edited";
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [{ kind: "update", resource }],
      authority,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toHaveLength(1);
    expect(result.plan.changes[0].path).toBe(path);
    expect(result.plan.changes[0].candidate?.mode).toBe("100755");
    expect(decodeSource(result.plan.changes[0].candidate!.bytes)).toBe(
      original.replace("title: Original # keep", 'title: "Edited" # keep'),
    );
    for (const before of project.tree.filter((entry) => entry.path !== path))
      expect(result.plan.candidate.tree.find((entry) => entry.path === before.path)).toEqual(
        before,
      );
    const fresh = await readSourceProject({ tree: result.plan.candidate.tree });
    expect(fresh.compilation.resources).toEqual(desired);
    expect(fresh.compilation.semantic).toEqual(project.compilation.semantic);
    expect(fresh.compilation.payloads).toEqual(project.compilation.payloads);
    const before = presented(content(project, resource).spec.content.value);
    const after = presented(content(fresh, resource).spec.content.value);
    expect(sameDocumentMeaning(before.document, after.document)).toBe(true);
    const noOp = await planSourceUpdates({
      project: fresh,
      expectedTreeDigest: fresh.treeDigest,
      packageCohort: cohort,
      desiredResources: fresh.compilation.resources,
      operations: [],
      authority: { resources: [], exclusive: [], shared: [], create: [] },
    });
    expect(noOp.ok && noOp.plan.changes).toEqual([]);
  },
);

test.each(["collection", "wiki"] as const)(
  "%s presentation option edit refreshes materialization while preserving payload, suffix and exact dependencies",
  async (kind) => {
    const { project, resource, authority, path } = await fixture(kind);
    const desired = structuredClone(project.compilation.resources);
    const guide = desired.find(
      (entry): entry is Guide | WikiPage => `${entry.type}/${entry.name}` === resource,
    )!;
    const authored = presented(guide.spec.content.value);
    const beforeOptions = structuredClone(authored.nodes.map((node) => node.options));
    const beforeSuffixes = authored.nodes.map((node) => node.opaqueMetaSuffix);
    const beforePayloads = authored.nodes.map((node) => {
      const child = node.children![0];
      return { value: child.value, template: child.template, lang: child.lang, meta: child.meta };
    });
    authored.nodes[0].options!.title = "Edited &amp; display label";
    guide.spec.content.value = writeDocument(authored.document);
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [{ kind: "update", resource }],
      authority,
      ...(kind === "wiki"
        ? { referenceContexts: { [resource]: project.wikiContexts["Wiki/handbook"] } }
        : {}),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes.map((change) => change.path)).toEqual([path]);
    expect(decodeSource(result.plan.changes[0].candidate!.bytes)).toMatch(
      /^---\r\nid: stable\r\ntitle: Original # keep\r\ncustom: exact\r\n---\r\n/,
    );
    for (const before of project.tree.filter((entry) => entry.path !== path))
      expect(result.plan.candidate.tree.find((entry) => entry.path === before.path)).toEqual(
        before,
      );
    const fresh = await readSourceProject({ tree: result.plan.candidate.tree });
    const after = presented(content(fresh, resource).spec.content.value);
    expect(sameDocumentMeaning(authored.document, after.document)).toBe(true);
    expect(after.nodes.map((node) => node.opaqueMetaSuffix)).toEqual(beforeSuffixes);
    expect(after.nodes.slice(1).map((node) => node.options)).toEqual(beforeOptions.slice(1));
    expect(
      after.nodes.map((node) => {
        const child = node.children![0];
        return { value: child.value, template: child.template, lang: child.lang, meta: child.meta };
      }),
    ).toEqual(beforePayloads);
    expect(fresh.compilation.semantic).toEqual(project.compilation.semantic);
    expect(fresh.compilation.resources.filter((entry) => entry.type === "Asset")).toEqual(
      project.compilation.resources.filter((entry) => entry.type === "Asset"),
    );
    expect(fresh.compilation.materialization.payloads).toEqual(
      project.compilation.materialization.payloads,
    );
    const priorRecord = project.compilation.materialization.resources.find(
      (entry) => entry.resource === resource,
    )!;
    const record = fresh.compilation.materialization.resources.find(
      (entry) => entry.resource === resource,
    )!;
    expect(record.sha256).not.toBe(priorRecord.sha256);
    expect(record.size).not.toBe(priorRecord.size);
    expect(
      validateTopikMaterializationRecord(
        project.compilation.materialization,
        fresh.compilation.resources,
        fresh.compilation.semantic,
      ).ok,
    ).toBe(false);
    expect(
      validateTopikMaterializationRecord(
        fresh.compilation.materialization,
        fresh.compilation.resources,
        fresh.compilation.semantic,
      ).ok,
    ).toBe(true);
  },
);

test.each(["collection", "wiki"] as const)(
  "%s refuses invalid presentation in an inactive branch without an applicable plan",
  async (kind) => {
    const { project, resource, authority } = await fixture(kind);
    const original = structuredClone(project.tree);
    const desired = structuredClone(project.compilation.resources);
    const page = desired.find(
      (entry): entry is Guide | WikiPage => `${entry.type}/${entry.name}` === resource,
    )!;
    const before = page.spec.content.value;
    page.spec.content.value = before.replace(
      'title="Alternative" wrap',
      'title="Alternative" highlight="3" wrap',
    );
    expect(page.spec.content.value).not.toBe(before);
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [{ kind: "update", resource }],
      authority,
    });
    expect(result.ok).toBe(false);
    expect(Object.hasOwn(result, "plan")).toBe(false);
    expect(project.tree).toEqual(original);
  },
);

test("saved source writer contexts pin both content grammar and canonicalizer identities", async () => {
  expect(SOURCE_WRITER_DESCRIPTOR.contentSchema).toBe(TOPIK_CONTENT_SCHEMA_VERSION);
  expect(SOURCE_WRITER_DESCRIPTOR.formatter).toBe(FORMAT_VERSION);
  const project = await readSourceProject({
    tree: [file(".topik.yaml", "version: 1\nnamespace: example/empty\nsources: []\n")],
  });
  for (const field of ["contentSchema", "formatter"] as const) {
    const stale = structuredClone(project);
    (stale.descriptor as unknown as Record<string, unknown>)[field] =
      field === "formatter" ? 0 : "0.2.0";
    const result = await planSourceUpdates({
      project: stale,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: [],
      operations: [],
      authority: { resources: [], exclusive: [], shared: [], create: [] },
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "source-writer-incompatible" }],
    });
    expect(Object.hasOwn(result, "plan")).toBe(false);
    const root = project.configurations.find((entry) => entry.path === ".topik.yaml")!;
    const addition = await addSourceToProject({
      project: stale,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      source: {
        kind: "collection",
        config: "guides/collection.yaml",
        id: "guides",
        title: "Guides",
      },
      resources: [],
      createPaths: ["guides/collection.yaml"],
      manifestAuthority: {
        ...root,
        fields: root.fields.filter((field) => field.selector === "sources/+"),
      },
    });
    expect(addition).toMatchObject({
      ok: false,
      diagnostics: [{ code: "source-writer-incompatible" }],
    });
    expect(Object.hasOwn(addition, "plan")).toBe(false);
  }
});
