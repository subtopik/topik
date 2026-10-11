import { posix } from "node:path";
import { expect, test } from "vite-plus/test";
import type { Resource } from "../resource";
import type { WikiNavNode } from "@topik/schema/wiki/v1";
import { resolveCourseContentHref, resolveCourseNavigation } from "../course-navigation";
import { resolveWikiContentHref, resolveWikiNavigation } from "../wiki-navigation";
import { readSourceProject, withSourceScratch, type SourceProject } from "./project";
import { compileManifest } from "../compile/manifest";
import { planSourceUpdates, type SourceResourceOperation } from "./plan";
import { decodeSource, encodeSource } from "./syntax";

type Kind = "wiki" | "course" | "collection";
type Page = Extract<Resource, { type: "WikiPage" | "CoursePage" | "Guide" }>;
type Declaration = { path: string; name: string; slug?: string; body?: string };
const cohort = "a".repeat(64);

test("public navigation routes retain their own slug grammar", () => {
  const wiki = resolveWikiNavigation(
    [{ type: "page", page: "home", slug: "con", sourcePath: "home" }],
    { sourceVersion: 1 },
  );
  expect(resolveWikiContentHref("/con", "home", wiki)?.page.page).toBe("home");
  const course = resolveCourseNavigation({
    course: "docs",
    modules: [{ name: "basics", slug: "basics" }],
    pages: [{ name: "home", module: "basics", slug: "con", sourcePath: "home" }],
  });
  expect(resolveCourseContentHref("/basics/con", "home", course)?.page.page).toBe("home");
});

const emptyAuthority = { resources: [], exclusive: [], shared: [], create: [] };
const file = (path: string, text: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(text),
});
const getPage = (resources: readonly Resource[], name = "home") =>
  resources.find(
    (resource): resource is Page =>
      ["WikiPage", "CoursePage", "Guide"].includes(resource.type) && resource.name === name,
  )!;
function tree(kind: Kind, pages: Declaration[], guides: Declaration[] = []) {
  const config = {
    id: "docs",
    title: "Docs",
    sourceVersion: 1,
    ...(kind === "wiki"
      ? {
          navigation: pages.map(({ path, name, slug }) => ({
            type: "page",
            source: path.replace(/\.mdx?$/, ""),
            slug: slug ?? name,
          })),
        }
      : kind === "course"
        ? {
            slug: "docs",
            modules: [
              {
                id: "basics",
                title: "Basics",
                slug: "basics",
                order: 0,
                pages: pages.map(({ path }) => path.replace(/\.mdx?$/, "")),
              },
            ],
          }
        : {}),
  };
  const collections = [
    ...new Set(
      (kind === "collection" ? [...pages, ...guides] : guides).map(({ path }) =>
        posix.dirname(path),
      ),
    ),
  ];
  const sources: { kind: Kind; config: string }[] =
    kind === "collection" ? [] : [{ kind, config: "config.yaml" }];
  const configurations = kind === "collection" ? [] : [file("config.yaml", JSON.stringify(config))];
  for (const [index, directory] of collections.entries()) {
    const path = posix.join(directory, "collection.yaml");
    sources.push({ kind: "collection", config: path });
    configurations.push(
      file(path, JSON.stringify({ id: `collection-${index}`, title: "Guides", sourceVersion: 1 })),
    );
  }
  return [
    file(".topik.yaml", JSON.stringify({ version: 1, namespace: "folders", sources })),
    ...configurations,
    ...[...pages, ...guides].map(({ path, name, slug, body }) =>
      file(
        path,
        `---\nid: ${name}\ntitle: ${name}\nslug: ${slug ?? name}\norder: 0\n---\n${body ?? "# Landing\n"}`,
      ),
    ),
  ];
}
const contexts = (project: SourceProject, kind: Kind, key: string) =>
  kind === "wiki"
    ? { referenceContexts: { [key]: project.wikiContexts["Wiki/docs"] } }
    : kind === "course"
      ? { courseReferenceContexts: { [key]: project.courseContexts["Course/docs"] } }
      : {};
const authority = (project: SourceProject) => ({
  resources: project.compilation.resources.map(({ type, name }) => `${type}/${name}`),
  exclusive: project.documents
    .filter(({ path, config }) => path !== config)
    .map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
  shared: project.configurations.filter(({ path }) => path !== ".topik.yaml"),
  create: [],
});
function resolve(project: SourceProject, kind: "wiki" | "course", href: string) {
  if (kind === "course")
    return resolveCourseContentHref(
      href,
      "home",
      resolveCourseNavigation(project.courseContexts["Course/docs"]),
    );
  const wiki = project.wikiContexts["Wiki/docs"];
  return resolveWikiContentHref(
    href,
    "home",
    resolveWikiNavigation(wiki.spec.navigation ?? [], { sourceVersion: wiki.spec.sourceVersion }),
  );
}
async function noop(project: SourceProject, kind: Kind, body?: string, authoringUpdate = false) {
  const desired = structuredClone(project.compilation.resources);
  const home = getPage(desired);
  if (body !== undefined) home.spec.content.value = body;
  const result = await planSourceUpdates({
    project,
    packageCohort: cohort,
    expectedTreeDigest: project.treeDigest,
    desiredResources: desired,
    operations: authoringUpdate ? [{ kind: "update", resource: `${home.type}/home` }] : [],
    authority: authoringUpdate ? authority(project) : emptyAuthority,
    ...contexts(project, kind, `${home.type}/home`),
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.ok && result.plan.changes).toEqual([]);
}

test.each(
  (["wiki", "course"] as const).flatMap((kind) =>
    [false, true].map((authored) => ({ kind, authored })),
  ),
)(
  "$kind preserves cross-source folder identity when a new route shadows it (authored=$authored)",
  async ({ kind, authored }) => {
    const route = kind === "wiki" ? "/files" : "/basics/files";
    const body = `# Home\n\n[Landing](${route}?q=%E9#landing)\n\n[Again](${route}?q=%E9#landing)\n`;
    const project = await readSourceProject({
      tree: tree(
        kind,
        [
          { path: "home.md", name: "home", body },
          { path: "other.md", name: "other" },
        ],
        [{ path: `${route.slice(1)}/index.md`, name: "landing" }],
      ),
    });
    const desired = structuredClone(project.compilation.resources);
    const home = getPage(desired);
    expect(home.spec.content.value).toContain("ref://guide/landing?q=%E9#landing");
    if (authored) home.spec.content.value = body;
    const other = getPage(desired, "other");
    const operations: SourceResourceOperation[] = authored
      ? [{ kind: "update", resource: `${home.type}/home` }]
      : [];
    if (other.type === "CoursePage") {
      other.spec.slug = "files";
      operations.push({ kind: "update", resource: "CoursePage/other" });
    } else {
      const wiki = desired.find((resource) => resource.type === "Wiki")!;
      const node = (wiki.spec.navigation as WikiNavNode[]).find(
        (node) => node.type === "page" && node.page === "other",
      )!;
      if (node.type === "page") node.slug = "files";
      operations.push({ kind: "update", resource: "Wiki/docs" });
    }
    const request = {
      project,
      packageCohort: cohort,
      expectedTreeDigest: project.treeDigest,
      desiredResources: desired,
      operations,
      authority: authority(project),
      ...contexts(project, kind, `${home.type}/home`),
    };
    const result = await planSourceUpdates(request);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(getPage(result.plan.candidate.compilation.resources).spec.content).toEqual(
      getPage(project.compilation.resources).spec.content,
    );
    expect(result.plan.derivedRepairs.filter(({ kind }) => kind === "reference")).toHaveLength(2);
    expect(
      decodeSource(result.plan.candidate.tree.find(({ path }) => path === "home.md")!.bytes),
    ).toContain(`[Landing](${route.slice(1)}/index.md?q=%E9#landing)`);
    for (const scope of ["resource", "file"] as const) {
      const admitted = authority(project);
      if (scope === "resource")
        admitted.resources = admitted.resources.filter((key) => key !== `${home.type}/home`);
      else admitted.exclusive = admitted.exclusive.filter(({ path }) => path !== "home.md");
      const denied = await planSourceUpdates({ ...request, authority: admitted });
      expect(denied).toMatchObject({
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: scope === "resource" ? "resource-scope-denied" : "exclusive-authority-required",
          }),
        ],
      });
    }
    await noop(result.plan.candidate, kind);
    await noop(
      result.plan.candidate,
      kind,
      getPage(result.plan.candidate.compilation.resources).spec.content.value.replaceAll(
        "ref://guide/landing?q=%E9#landing",
        `${route.slice(1)}/index.md?q=%E9#landing`,
      ),
      true,
    );
  },
);

test.each(["", "section/"])(
  "Wiki %sindex route aliases agree with compilation and no-op writes",
  async (prefix) => {
    const href = `/${prefix}index?q=%E9#landing`;
    const body = `# Home\n\n[Root](${href})\n`;
    const project = await readSourceProject({
      tree: tree("wiki", [
        { path: "home.md", name: "home", body },
        { path: "root.md", name: "root", slug: prefix ? "section" : "index" },
        { path: `${prefix}index/README.md`, name: "landing" },
      ]),
    });
    expect(getPage(project.compilation.resources).spec.content.value).toContain(
      "ref://wiki-page/root?q=%E9#landing",
    );
    expect(resolve(project, "wiki", href)?.page.page).toBe("root");
    await noop(project, "wiki");
    await noop(project, "wiki", body);
  },
);

test.each(
  (["wiki", "course"] as const).flatMap((kind) =>
    [
      "./files//nested/",
      "./files/%2Fnested/",
      "./files/./nested/",
      "./files/unused/../nested/",
    ].map((path) => ({ kind, path })),
  ),
)("$kind normalizes $path consistently across APIs", async ({ kind, path }) => {
  const href = `${path}?q=%E9#landing`;
  const body = `# Home\n\n[Landing](${href})\n`;
  const project = await readSourceProject({
    tree: tree(kind, [
      { path: "home.md", name: "home", body },
      { path: "files/nested/index.md", name: "landing" },
    ]),
  });
  expect(getPage(project.compilation.resources).spec.content.value).toContain(
    `ref://${kind}-page/landing?q=%E9#landing`,
  );
  expect(resolve(project, kind, href)).toMatchObject({
    page: { page: "landing" },
    search: "?q=%E9",
    hash: "landing",
  });
  expect(resolve(project, kind, "../files/nested/")).toBeNull();
  await noop(project, kind);
  await noop(project, kind, body);
});

test.each(["wiki", "course", "collection"] as const)(
  "%s contained parent-folder paths can select the project-root landing",
  async (kind) => {
    const pages = [
      { path: "nested/home.md", name: "home", body: "# Home\n\n[Landing](../?q=%E9#landing)\n" },
      { path: "index.md", name: "landing" },
    ];
    const control = await readSourceProject({
      tree: tree(kind, [
        { ...pages[0], body: pages[0].body!.replace("../?", "../index.md?") },
        pages[1],
      ]),
    });
    const project = await readSourceProject({ tree: tree(kind, pages) });
    expect(getPage(project.compilation.resources).spec.content).toEqual(
      getPage(control.compilation.resources).spec.content,
    );
    if (kind !== "collection")
      expect(resolve(project, kind, "../?q=%E9#landing")?.page.page).toBe("landing");
    await noop(project, kind);
  },
);

test.each(
  (["wiki", "course", "collection"] as const).flatMap((kind) =>
    (["error", "warning", "off"] as const).flatMap((links) =>
      [false, true].map((card) => ({ kind, links, card })),
    ),
  ),
)(
  "$kind rejects out-of-root folder references (card=$card, links=$links)",
  async ({ kind, links, card }) => {
    const href = "../../target/files/";
    const body = card ? `{% card href="${href}" title="Landing" /%}\n` : `[Landing](${href})\n`;
    await withSourceScratch(
      tree(kind, [{ path: "nested/home.md", name: "home", body }]),
      async (dir) => {
        const compilation = compileManifest({ dir, validation: { links } });
        if (links === "error")
          await expect(compilation).rejects.toMatchObject({
            diagnostics: [expect.objectContaining({ id: "link-page-not-found" })],
          });
        else {
          const result = await compilation;
          expect(result.references).toEqual([]);
          expect(result.diagnostics).toEqual(
            links === "off"
              ? []
              : [expect.objectContaining({ id: "link-page-not-found", level: "warning" })],
          );
        }
      },
    );
  },
);

test.each(
  [
    ...(["wiki", "course"] as const).flatMap((kind) =>
      ["con", "aux", "normal"].map((slug) => ({ kind, slug, moduleSlug: "basics" })),
    ),
    ...["con", "aux"].map((moduleSlug) => ({
      kind: "course" as const,
      slug: "normal",
      moduleSlug,
    })),
  ].flatMap((entry) => ["", "docs"].map((directory) => ({ ...entry, directory }))),
)(
  "$kind public route $moduleSlug/$slug is independent of filenames ($directory)",
  async ({ kind, slug, moduleSlug, directory }) => {
    const route = kind === "course" ? `/${moduleSlug}/${slug}` : `/${slug}`;
    const href = `${route}?q=%E9&discount=25%#landing`;
    const body = `# Home\n\n[Lesson](${href})\n\n{% card title="Lesson" href="${href}" /%}\n`;
    const files = tree(kind, [
      { path: "home.md", name: "home", body },
      { path: "lesson.md", name: "lesson", slug },
    ]);
    if (kind === "course") {
      const config = files.find(({ path }) => path === "config.yaml")!;
      const value = JSON.parse(decodeSource(config.bytes));
      value.modules[0].slug = moduleSlug;
      config.bytes = encodeSource(JSON.stringify(value));
    }
    for (const entry of files) {
      if (entry.path === ".topik.yaml") {
        const manifest = JSON.parse(decodeSource(entry.bytes));
        for (const source of manifest.sources) source.config = posix.join(directory, source.config);
        entry.bytes = encodeSource(JSON.stringify(manifest));
      } else entry.path = posix.join(directory, entry.path);
    }
    const project = await readSourceProject({ tree: files });
    expect(project.compilation.references).toHaveLength(2);
    expect(
      project.compilation.references.every(
        ({ reference }) =>
          reference.name === "lesson" &&
          reference.search === "?q=%E9&discount=25%" &&
          reference.hash === "landing",
      ),
    ).toBe(true);
    expect(resolve(project, kind, href)?.page.page).toBe("lesson");
    await noop(project, kind);
    await noop(project, kind, body);
    const desired = structuredClone(project.compilation.resources);
    const home = getPage(desired);
    home.spec.content.value = `${body}\nEdited paragraph.\n`;
    const result = await planSourceUpdates({
      project,
      expectedTreeDigest: project.treeDigest,
      packageCohort: cohort,
      desiredResources: desired,
      operations: [{ kind: "update", resource: `${home.type}/home` }],
      authority: authority(project),
      ...contexts(project, kind, `${home.type}/home`),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      const written = decodeSource(
        result.plan.candidate.tree.find(({ path }) => path === posix.join(directory, "home.md"))!
          .bytes,
      );
      expect(written).toContain(href);
      expect(written).toContain("Edited paragraph.");
      await noop(result.plan.candidate, kind);
    }
    // The same spelling with a slash requests a physical folder, not the public route.
    const invalid = files.map((entry) =>
      entry.path === posix.join(directory, "home.md")
        ? { ...entry, bytes: encodeSource(decodeSource(entry.bytes).replaceAll(href, `${route}/`)) }
        : entry,
    );
    await withSourceScratch(invalid, async (dir) => {
      await expect(compileManifest({ dir })).rejects.toMatchObject({
        diagnostics: [
          expect.objectContaining({ id: "link-page-not-found" }),
          expect.objectContaining({ id: "link-page-not-found" }),
        ],
      });
    });
  },
);

test.each(
  (["wiki", "course", "collection"] as const).flatMap((kind) =>
    ["./missing%/", "./missing%E9/", "./missing%E9%2F", "./missing%.md/"].flatMap((href) =>
      (["error", "warning", "off"] as const).flatMap((links) =>
        [false, true].map((card) => ({ kind, href, links, card })),
      ),
    ),
  ),
)(
  "$kind malformed folder $href follows links=$links (card=$card)",
  async ({ kind, href, links, card }) => {
    const body = card ? `{% card title="Folder" href="${href}" /%}\n` : `[Folder](${href})\n`;
    await withSourceScratch(tree(kind, [{ path: "home.md", name: "home", body }]), async (dir) => {
      const result = compileManifest({ dir, validation: { links } });
      if (links === "error")
        await expect(result).rejects.toMatchObject({
          diagnostics: [expect.objectContaining({ id: "link-page-not-found" })],
        });
      else {
        const compiled = await result;
        expect(compiled.references).toEqual([]);
        expect(compiled.diagnostics).toEqual(
          links === "off"
            ? []
            : [expect.objectContaining({ id: "link-page-not-found", level: "warning" })],
        );
      }
    });
  },
);

test.each(
  (["wiki", "course", "collection"] as const).flatMap((kind) =>
    ["?q=%E9", "?discount=25%"].map((query) => ({ kind, query })),
  ),
)("$kind folder queries remain opaque: $query", async ({ kind, query }) => {
  const href = `./files/${query}#landing`;
  const body = `[Folder](${href})\n\n{% card title="Folder" href="${href}" /%}\n`;
  const project = await readSourceProject({
    tree: tree(kind, [
      { path: "home.md", name: "home", body },
      { path: "files/index.md", name: "landing" },
    ]),
  });
  expect(project.compilation.references).toHaveLength(2);
  expect(
    project.compilation.references.every(
      ({ reference }) =>
        reference.name === "landing" && reference.search === query && reference.hash === "landing",
    ),
  ).toBe(true);
  await noop(project, kind);
});
