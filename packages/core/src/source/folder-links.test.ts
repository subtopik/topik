import { expect, test } from "vite-plus/test";
import type { CoursePage } from "@topik/schema/course-page/v1";
import type { Guide } from "@topik/schema/guide/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { WikiNavNode } from "@topik/schema/wiki/v1";
import { readSourceProject, type SourceProject } from "./project";
import { planSourceUpdates, type SourceResourceOperation } from "./plan";
import { decodeSource, encodeSource } from "./syntax";

type Kind = "wiki" | "course" | "collection";
type Page = WikiPage | CoursePage | Guide;
const cohort = "a".repeat(64);
const file = (path: string, text: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(text),
});
const body = "# Home\n\n[Folder](./files?view=%FF#landing)\n\n[Again](./files/?view=%FF#landing)\n";
const frontmatter = (id: string, value: string) =>
  `---\nid: ${id}\ntitle: ${id}\nslug: ${id}\norder: 0\n---\n${value}`;
const getPage = (resources: SourceProject["compilation"]["resources"], name = "home") =>
  resources.find(
    (resource): resource is Page =>
      ["CoursePage", "WikiPage", "Guide"].includes(resource.type) && resource.name === name,
  )!;
const authority = (project: SourceProject) => ({
  resources: project.compilation.resources.map((resource) => `${resource.type}/${resource.name}`),
  exclusive: project.documents
    .filter((document) => document.path !== document.config)
    .map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
  shared: project.configurations.filter((config) => config.path !== ".topik.yaml"),
  create: [] as string[],
});
const contexts = (project: SourceProject, kind: Kind, key: string) =>
  kind === "course"
    ? { courseReferenceContexts: { [key]: project.courseContexts["Course/docs"] } }
    : kind === "wiki"
      ? { referenceContexts: { [key]: project.wikiContexts["Wiki/docs"] } }
      : {};
async function fixture(kind: Kind, value = body) {
  const sources = ["home", "other", "files/index"];
  const config = {
    id: "docs",
    title: "Docs",
    sourceVersion: 1,
    ...(kind === "wiki"
      ? {
          navigation: sources.map((source, index) => ({
            type: "page",
            slug: ["home", "other", "landing"][index],
            source,
          })),
        }
      : kind === "course"
        ? {
            slug: "docs",
            modules: [{ id: "basics", title: "Basics", slug: "basics", order: 0, pages: sources }],
          }
        : {}),
  };
  return readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        JSON.stringify({
          version: 1,
          namespace: "folders",
          sources: [
            { kind, config: "docs/config.yaml" },
            ...(kind === "collection" ? [{ kind, config: "docs/files/collection.yaml" }] : []),
          ],
        }),
      ),
      file("docs/config.yaml", JSON.stringify(config)),
      ...(kind === "collection"
        ? [file("docs/files/collection.yaml", "id: landings\ntitle: Landings\nsourceVersion: 1\n")]
        : []),
      file("docs/home.md", frontmatter("home", value)),
      file("docs/other.md", frontmatter("other", "# Other\n")),
      file("docs/files/index.md", frontmatter("landing", "# Landing\n")),
    ],
  });
}

test.each(["wiki", "course"] as const)(
  "%s public routes retain identity when another source declares a same-path folder landing",
  async (kind) => {
    const route = kind === "wiki" ? "/files" : "/basics/home";
    const value = `# Home\n\n[Home](${route}?view=%FF#home)\n`;
    const config = {
      id: "docs",
      title: "Docs",
      sourceVersion: 1,
      ...(kind === "wiki"
        ? {
            navigation: [{ type: "page", slug: "files", source: "home" }],
          }
        : {
            slug: "docs",
            modules: [{ id: "basics", title: "Basics", slug: "basics", order: 0, pages: ["home"] }],
          }),
    };
    const project = await readSourceProject({
      tree: [
        file(
          ".topik.yaml",
          JSON.stringify({
            version: 1,
            namespace: "folders",
            sources: [
              { kind, config: "docs/config.yaml" },
              { kind: "collection", config: `docs${route}/collection.yaml` },
            ],
          }),
        ),
        file("docs/config.yaml", JSON.stringify(config)),
        file("docs/home.md", frontmatter("home", value)),
        file(`docs${route}/collection.yaml`, "id: landings\ntitle: Landings\nsourceVersion: 1\n"),
        file(`docs${route}/README.md`, frontmatter("landing", "# Landing\n")),
      ],
    });
    const desired = structuredClone(project.compilation.resources);
    const home = getPage(desired);
    expect(home.spec.content.value).toContain(`ref://${kind}-page/home?view=%FF#home`);
    home.spec.content.value = value;
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [],
      authority: { resources: [], exclusive: [], shared: [], create: [] },
      ...contexts(project, kind, `${home.type}/home`),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.ok && result.plan.changes).toEqual([]);
  },
);

test.each(
  (["wiki", "course", "collection"] as const).flatMap((kind) =>
    [false, true].map((authored) => ({ kind, authored })),
  ),
)(
  "$kind preserves folder identities and authority across round trips (authored=$authored)",
  async ({ kind, authored }) => {
    const project = await fixture(kind);
    const desired = structuredClone(project.compilation.resources);
    const home = getPage(desired);
    if (authored) home.spec.content.value = body;
    const key = `${home.type}/home`;
    const operations: SourceResourceOperation[] =
      kind === "collection" && authored ? [{ kind: "update", resource: key }] : [];
    const request = {
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations,
      authority: authority(project),
      ...contexts(project, kind, key),
    };
    const noop = await planSourceUpdates(request);
    expect(noop.ok, JSON.stringify(noop)).toBe(true);
    expect(noop.ok && noop.plan.changes).toEqual([]);
    const movedPath = kind === "collection" ? "docs/files/moved.md" : "docs/moved.md";
    const moved = await planSourceUpdates({
      ...request,
      operations: [
        ...operations,
        { kind: "move", resource: `${home.type}/landing`, path: movedPath },
      ],
      authority: { ...authority(project), create: [movedPath] },
    });
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok) return;
    expect(getPage(moved.plan.candidate.compilation.resources).spec.content).toEqual(
      getPage(project.compilation.resources).spec.content,
    );
    expect(moved.plan.derivedRepairs.filter((repair) => repair.kind === "reference")).toHaveLength(
      2,
    );
    const destination =
      kind === "course" ? "/basics/landing" : kind === "wiki" ? "/landing" : "files/moved.md";
    expect(
      decodeSource(moved.plan.candidate.tree.find((entry) => entry.path === "docs/home.md")!.bytes),
    ).toContain(`[Folder](${destination}?view=%FF#landing)`);
    for (const scope of ["resource", "file"] as const) {
      const admitted = authority(project);
      if (scope === "resource")
        admitted.resources = admitted.resources.filter((resource) => resource !== key);
      else admitted.exclusive = admitted.exclusive.filter(({ path }) => path !== "docs/home.md");
      const denied = await planSourceUpdates({
        ...request,
        operations: [
          ...operations,
          { kind: "move", resource: `${home.type}/landing`, path: movedPath },
        ],
        authority: { ...admitted, create: [movedPath] },
      });
      expect(denied).toMatchObject({
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: scope === "resource" ? "resource-scope-denied" : "exclusive-authority-required",
          }),
        ],
      });
    }
    const repeated = await planSourceUpdates({
      project: moved.plan.candidate,
      expectedTreeDigest: moved.plan.candidateTreeDigest,
      packageCohort: cohort,
      desiredResources: moved.plan.candidate.compilation.resources,
      operations: [],
      authority: { resources: [], exclusive: [], shared: [], create: [] },
    });
    expect(repeated.ok && repeated.plan.changes).toEqual([]);

    // A new same-stem page must not steal an existing folder's declared target.
    const admitted = authority(project);
    if (!(kind === "collection" && authored)) {
      admitted.resources = admitted.resources.filter((resource) => resource !== key);
      admitted.exclusive = admitted.exclusive.filter(({ path }) => path !== "docs/home.md");
    }
    const collision = await planSourceUpdates({
      ...request,
      operations: [
        ...operations,
        { kind: "move", resource: `${home.type}/other`, path: "docs/files.md" },
      ],
      authority: { ...admitted, create: ["docs/files.md"] },
    });
    expect(collision.ok, JSON.stringify(collision)).toBe(true);
    if (collision.ok) {
      expect(getPage(collision.plan.candidate.compilation.resources).spec.content).toEqual(
        getPage(project.compilation.resources).spec.content,
      );
      expect(collision.plan.changes.some(({ path }) => path === "docs/home.md")).toBe(false);
    }
    const withoutLanding = structuredClone(desired).filter(
      (resource) => resource.name !== "landing",
    );
    const wiki = withoutLanding.find((resource) => resource.type === "Wiki");
    if (wiki?.type === "Wiki")
      wiki.spec.navigation = (wiki.spec.navigation as WikiNavNode[]).filter(
        (node) => node.type !== "page" || node.page !== "landing",
      ) as typeof wiki.spec.navigation;
    const removed = await planSourceUpdates({
      ...request,
      desiredResources: withoutLanding,
      operations: [
        ...operations,
        { kind: "delete", resource: `${home.type}/landing` },
        ...(wiki ? [{ kind: "update" as const, resource: "Wiki/docs" }] : []),
      ],
    });
    expect(removed).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "reference-target-removed" })],
    });
  },
);

test.each(["wiki", "course", "collection"] as const)(
  "%s admits new authored folder links and new pages from their configuration root",
  async (kind) => {
    const project = await fixture(kind, "# Home\n");
    const desired = structuredClone(project.compilation.resources);
    const home = getPage(desired);
    home.spec.content.value = body;
    const created = structuredClone(home);
    created.name = "created";
    if (created.type !== "WikiPage") created.spec.slug = "created";
    created.spec.content.value = "# Created\n\n[Landing](/files/?view=full#landing)\n";
    desired.push(created);
    const wiki = desired.find((resource) => resource.type === "Wiki");
    if (wiki?.type === "Wiki")
      (wiki.spec.navigation as WikiNavNode[]).push({
        type: "page",
        page: "created",
        slug: "created",
        sourcePath: "nested/new",
      });
    const key = `${home.type}/home`;
    const createdKey = `${created.type}/created`;
    const createdPath = kind === "collection" ? "docs/new.md" : "docs/nested/new.md";
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [
        { kind: "update", resource: key },
        {
          kind: "create",
          resource: createdKey,
          config: "docs/config.yaml",
          path: createdPath,
        },
        ...(wiki ? [{ kind: "update" as const, resource: "Wiki/docs" }] : []),
      ],
      authority: {
        ...authority(project),
        resources: [...authority(project).resources, createdKey],
        create: [createdPath],
      },
      ...contexts(project, kind, key),
      ...(wiki?.type === "Wiki"
        ? { referenceContexts: { [key]: project.wikiContexts["Wiki/docs"], [createdKey]: wiki } }
        : {}),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(
      getPage(result.plan.candidate.compilation.resources, "created").spec.content.value,
    ).toContain(`/landing?view=full#landing`);
    expect(
      decodeSource(result.plan.candidate.tree.find(({ path }) => path === createdPath)!.bytes),
    ).toContain(
      kind === "collection"
        ? "[Landing](ref://guide/landing?view=full#landing)"
        : "[Landing](/files/?view=full#landing)",
    );
  },
);

test.each(["wiki", "course", "collection"] as const)(
  "%s repairs a saved folder identity before adding a competing landing",
  async (kind) => {
    const project = await fixture(kind);
    const desired = structuredClone(project.compilation.resources);
    const home = getPage(desired);
    const competing = structuredClone(getPage(desired, "landing"));
    competing.name = "readme";
    if (competing.type === "CoursePage") competing.spec.slug = "readme";
    desired.push(competing);
    const wiki = desired.find((resource) => resource.type === "Wiki");
    if (wiki?.type === "Wiki")
      (wiki.spec.navigation as WikiNavNode[]).push({
        type: "page",
        page: "readme",
        slug: "readme",
        sourcePath: "files/README",
      });
    const newKey = `${home.type}/readme`;
    const request = {
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [
        {
          kind: "create" as const,
          resource: newKey,
          config: kind === "collection" ? "docs/files/collection.yaml" : "docs/config.yaml",
          path: "docs/files/README.md",
        },
        ...(wiki ? [{ kind: "update" as const, resource: "Wiki/docs" }] : []),
      ],
      ...(wiki?.type === "Wiki" ? { referenceContexts: { [newKey]: wiki } } : {}),
      authority: {
        ...authority(project),
        resources: [...authority(project).resources, newKey],
        create: ["docs/files/README.md"],
      },
    };
    const result = await planSourceUpdates(request);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok)
      expect(getPage(result.plan.candidate.compilation.resources).spec.content).toEqual(
        home.spec.content,
      );
    const denied = await planSourceUpdates({
      ...request,
      authority: {
        ...request.authority,
        resources: request.authority.resources.filter((key) => key !== `${home.type}/home`),
      },
    });
    expect(denied).toMatchObject({
      ok: false,
      diagnostics: [{ code: "resource-scope-denied", resource: `${home.type}/home` }],
    });
  },
);
