import { expect, test } from "vite-plus/test";
import type { CoursePage } from "@topik/schema/course-page/v1";
import type { Guide } from "@topik/schema/guide/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import { readSourceProject, type SourceProject } from "./project";
import { planSourceUpdates, type SourceResourceOperation, type SourceWriteAuthority } from "./plan";
import { decodeSource, encodeSource } from "./syntax";

const cohort = "a".repeat(64);
const file = (path: string, text: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(text),
});
const page = (id: string, body: string) =>
  `---\nid: ${id}\ntitle: ${id}\nslug: ${id}\norder: 0\n---\n${body}`;
const authority = (project: SourceProject): SourceWriteAuthority => ({
  resources: project.compilation.resources.map((resource) => `${resource.type}/${resource.name}`),
  exclusive: project.documents
    .filter((document) => document.path !== document.config)
    .map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
  shared: project.configurations.filter((config) => config.path !== ".topik.yaml"),
  create: [],
});
const home = (resources: SourceProject["compilation"]["resources"]) =>
  resources.find(
    (resource): resource is CoursePage | WikiPage | Guide =>
      ["CoursePage", "WikiPage", "Guide"].includes(resource.type) && resource.name === "home",
  )!;

async function projectFor(
  kind: "course" | "wiki" | "guide-course",
  body: string,
  includeOther = false,
) {
  return readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        `version: 1\nnamespace: links\nsources: [${kind === "guide-course" ? "{kind: collection, config: guides/collection.yaml}, " : ""}{kind: ${kind === "wiki" ? "wiki" : "course"}, config: lessons/config.yaml}]\n`,
      ),
      file(
        "lessons/config.yaml",
        kind === "wiki"
          ? `id: lessons\ntitle: Lessons\nsourceVersion: 1\nnavigation: [home, next${includeOther ? ", other" : ""}]\n`
          : `id: lessons\ntitle: Lessons\nslug: lessons\nsourceVersion: 1\nmodules: [{id: basics, title: Basics, slug: basics, order: 0, pages: [${kind === "guide-course" ? "" : "home, "}next${includeOther ? ", other" : ""}]}]\n`,
      ),
      ...(kind === "guide-course"
        ? [file("guides/collection.yaml", "id: guides\ntitle: Guides\nsourceVersion: 1\n")]
        : []),
      file(`${kind === "guide-course" ? "guides" : "lessons"}/home.md`, page("home", body)),
      file("lessons/next.md", page("target", "# Next\n")),
      ...(includeOther ? [file("lessons/other.md", page("other", "# Other\n"))] : []),
    ],
  });
}

test.each(
  (["course", "wiki", "guide-course"] as const).flatMap((kind) =>
    ["authored", "compiled"].map((representation) => ({ kind, representation })),
  ),
)(
  "$kind preserves $representation links when an unrelated move creates a directory alias",
  async ({ kind, representation }) => {
    const href = kind === "guide-course" ? "../lessons/next" : "./next";
    const body = `# Home\n\n[Target](${href})\n\n[Again](${href})\n`;
    const project = await projectFor(kind, body, true);
    const desired = structuredClone(project.compilation.resources);
    if (representation === "authored") home(desired).spec.content.value = body;
    const key = `${home(desired).type}/home`;
    const targetType = kind === "wiki" ? "WikiPage" : "CoursePage";
    const homePath = `${kind === "guide-course" ? "guides" : "lessons"}/home.md`;
    const targetPath = "lessons/next/new.md";
    const request = {
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [
        ...(kind === "guide-course" && representation === "authored"
          ? [{ kind: "update" as const, resource: key }]
          : []),
        { kind: "move" as const, resource: `${targetType}/other`, path: targetPath },
      ],
      authority: { ...authority(project), create: [targetPath] },
      ...(kind === "course"
        ? { courseReferenceContexts: { [key]: project.courseContexts["Course/lessons"] } }
        : kind === "wiki"
          ? { referenceContexts: { [key]: project.wikiContexts["Wiki/lessons"] } }
          : {}),
    };
    const result = await planSourceUpdates(request);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(home(result.plan.candidate.compilation.resources).spec.content).toEqual(
      home(project.compilation.resources).spec.content,
    );
    const repaired =
      kind === "course" ? "/basics/target" : kind === "wiki" ? "/next" : "../lessons/next.md";
    expect(result.plan.derivedRepairs.filter((repair) => repair.kind === "reference")).toEqual([
      expect.objectContaining({ resource: key, before: href, after: repaired, target: "target" }),
      expect.objectContaining({ resource: key, before: href, after: repaired, target: "target" }),
    ]);
    expect(
      decodeSource(result.plan.candidate.tree.find((entry) => entry.path === homePath)!.bytes),
    ).toContain(`[Target](${repaired})\n\n[Again](${repaired})`);
    expect(result.plan.candidate.tree.find((entry) => entry.path === "lessons/next.md")).toEqual(
      project.tree.find((entry) => entry.path === "lessons/next.md"),
    );
    const denied = await planSourceUpdates({
      ...request,
      authority: {
        ...request.authority,
        resources: request.authority.resources.filter((entry) => entry !== key),
      },
    });
    expect(denied).toMatchObject({
      ok: false,
      diagnostics: [{ code: "resource-scope-denied", resource: key }],
    });
    const deniedFile = await planSourceUpdates({
      ...request,
      authority: {
        ...request.authority,
        exclusive: request.authority.exclusive.filter((entry) => entry.path !== homePath),
      },
    });
    expect(deniedFile).toMatchObject({
      ok: false,
      diagnostics: [{ code: "exclusive-authority-required", path: homePath }],
    });
    const repeated = await planSourceUpdates({
      project: result.plan.candidate,
      expectedTreeDigest: result.plan.candidateTreeDigest,
      packageCohort: cohort,
      desiredResources: result.plan.candidate.compilation.resources,
      operations: [],
      authority: { resources: [], exclusive: [], shared: [], create: [] },
    });
    expect(repeated.ok && repeated.plan.changes).toEqual([]);
    if (kind !== "guide-course") {
      const retained = structuredClone(result.plan.candidate.compilation.resources);
      home(retained).spec.content.value =
        `# Home\n\n[Target](${repaired})\n\n[Again](${repaired})\n`;
      const repeatedAuthored = await planSourceUpdates({
        project: result.plan.candidate,
        expectedTreeDigest: result.plan.candidateTreeDigest,
        packageCohort: cohort,
        desiredResources: retained,
        operations: [],
        authority: { resources: [], exclusive: [], shared: [], create: [] },
        ...(kind === "course"
          ? {
              courseReferenceContexts: {
                [key]: result.plan.candidate.courseContexts["Course/lessons"],
              },
            }
          : { referenceContexts: { [key]: result.plan.candidate.wikiContexts["Wiki/lessons"] } }),
      });
      expect(repeatedAuthored.ok && repeatedAuthored.plan.changes).toEqual([]);
    }
  },
);

test.each(
  (["course", "wiki", "guide-course"] as const).flatMap((kind) =>
    [false, true].map((fresh) => ({ kind, fresh })),
  ),
)(
  "$kind transports page links before a move creates their old directory (fresh=$fresh)",
  async ({ kind, fresh }) => {
    const href = kind === "guide-course" ? "../lessons/next" : "./next";
    const body = `# Home\n\n[Target](${href})\n`;
    const project = await projectFor(kind, fresh ? "# Home\n" : body);
    const desired = structuredClone(project.compilation.resources);
    const updated = home(desired);
    updated.spec.content.value = body;
    const key = `${updated.type}/${updated.name}`;
    const targetType = kind === "wiki" ? "WikiPage" : "CoursePage";
    const targetPath = "lessons/next/new.md";
    const operations: SourceResourceOperation[] = [
      ...(fresh || kind === "guide-course" ? [{ kind: "update" as const, resource: key }] : []),
      { kind: "move", resource: `${targetType}/target`, path: targetPath },
    ];
    const request = {
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations,
      authority: { ...authority(project), create: [targetPath] },
      ...(kind === "course"
        ? { courseReferenceContexts: { [key]: project.courseContexts["Course/lessons"] } }
        : kind === "wiki"
          ? { referenceContexts: { [key]: project.wikiContexts["Wiki/lessons"] } }
          : {}),
    };
    const result = await planSourceUpdates(request);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const repaired =
      kind === "course" ? "/basics/target" : kind === "wiki" ? "/next" : "../lessons/next/new.md";
    expect(home(result.plan.candidate.compilation.resources).spec.content.value).toContain(
      `ref://${kind === "wiki" ? "wiki-page" : "course-page"}/target`,
    );
    expect(result.plan.derivedRepairs).toContainEqual(
      expect.objectContaining({ resource: key, kind: "reference", before: href, after: repaired }),
    );
    const homePath = `${kind === "guide-course" ? "guides" : "lessons"}/home.md`;
    expect(
      decodeSource(result.plan.candidate.tree.find((entry) => entry.path === homePath)!.bytes),
    ).toContain(`[Target](${repaired})`);
    if (!fresh && kind !== "guide-course") {
      const denied = await planSourceUpdates({
        ...request,
        authority: {
          ...request.authority,
          resources: request.authority.resources.filter((entry) => entry !== key),
        },
      });
      expect(denied).toMatchObject({
        ok: false,
        diagnostics: [{ code: "resource-scope-denied", resource: key }],
      });
    }
    const repeated = await planSourceUpdates({
      project: result.plan.candidate,
      expectedTreeDigest: result.plan.candidateTreeDigest,
      packageCohort: cohort,
      desiredResources: result.plan.candidate.compilation.resources,
      operations: [],
      authority: { resources: [], exclusive: [], shared: [], create: [] },
    });
    expect(repeated.ok && repeated.plan.changes).toEqual([]);
  },
);

test("a newly authored directory link without a saved page target stays literal", async () => {
  const project = await projectFor("course", "# Home\n");
  const desired = structuredClone(project.compilation.resources);
  home(desired).spec.content.value = "# Home\n\n[Directory](./created)\n";
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [
      { kind: "update", resource: "CoursePage/home" },
      { kind: "move", resource: "CoursePage/target", path: "lessons/created/next.md" },
    ],
    authority: { ...authority(project), create: ["lessons/created/next.md"] },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(home(result.plan.candidate.compilation.resources).spec.content.value).toBe(
    home(desired).spec.content.value,
  );
  expect(result.plan.derivedRepairs.some((repair) => repair.kind === "reference")).toBe(false);
});

test.each(["/next.md/", "/next.md///?a=b#next", "/next.md%2F%2F?discount=25%#next"])(
  "Course source spelling %s survives no-ops and edits, and repairs on moves",
  async (href) => {
    const body = `# Home\n\n[Target](${href})\n`;
    const project = await projectFor("course", body);
    const request = {
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: project.compilation.resources,
      operations: [],
      authority: { resources: [], exclusive: [], shared: [], create: [] },
    };
    const noop = await planSourceUpdates(request);
    expect(noop.ok, JSON.stringify(noop)).toBe(true);
    expect(noop.ok && noop.plan.changes).toEqual([]);
    const desired = structuredClone(project.compilation.resources);
    home(desired).spec.content.value += "\nAdded text.\n";
    const edit = await planSourceUpdates({
      ...request,
      desiredResources: desired,
      operations: [{ kind: "update", resource: "CoursePage/home" }],
      authority: authority(project),
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    if (!edit.ok) return;
    expect(
      decodeSource(
        edit.plan.candidate.tree.find((entry) => entry.path === "lessons/home.md")!.bytes,
      ),
    ).toContain(`[Target](${href})`);
    const moved = await planSourceUpdates({
      ...request,
      operations: [{ kind: "move", resource: "CoursePage/target", path: "lessons/moved.md" }],
      authority: { ...authority(project), create: ["lessons/moved.md"] },
    });
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok) return;
    const suffix = new URL(href, "https://example.test");
    expect(
      decodeSource(
        moved.plan.candidate.tree.find((entry) => entry.path === "lessons/home.md")!.bytes,
      ),
    ).toContain(`[Target](/basics/target${suffix.search}${suffix.hash})`);
    expect(home(moved.plan.candidate.compilation.resources).spec.content.value).toBe(
      home(project.compilation.resources).spec.content.value,
    );
  },
);
