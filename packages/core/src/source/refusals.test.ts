import { createHash } from "node:crypto";
import { expect, test } from "vite-plus/test";
import type { WikiNavNode } from "@topik/schema/wiki/v1";
import type { Resource } from "../resource";
import { sourcePlanDiagnosticCategory } from "./diagnostics";
import { initializeSourceProject } from "./initialize";
import { planSourceUpdates, type SourceResourceOperation } from "./plan";
import { digestSourceTree, readSourceProject, type SourceProject } from "./project";
import { encodeSource } from "./syntax";

const cohort = "a".repeat(64);
const file = (path: string, raw: string | Uint8Array) => ({
  path,
  mode: "100644" as const,
  bytes: typeof raw === "string" ? encodeSource(raw) : raw,
});
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Everything the project has: refusals here must not come from missing authority. */
const everything = (project: SourceProject) => ({
  resources: project.compilation.resources.map((resource) => `${resource.type}/${resource.name}`),
  exclusive: project.documents
    .filter((document) => /\.mdx?$/u.test(document.path))
    .map(({ path, sha256, mode }) => ({ path, sha256, mode })),
  shared: project.configurations.filter((config) => config.path !== ".topik.yaml"),
  create: [],
});

async function refusal(
  tree: ReturnType<typeof file>[],
  edit: (desired: Resource[]) => SourceResourceOperation[],
) {
  const project = await readSourceProject({ tree });
  const desired = structuredClone(project.compilation.resources);
  const operations = edit(desired);
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations,
    authority: everything(project),
  });
  expect(result.ok).toBe(false);
  return result.ok ? undefined : result.diagnostics[0];
}

const course = [
  file(
    ".topik.yaml",
    "version: 1\nnamespace: refusals\nsources: [{kind: course, config: course.yaml}]\n",
  ),
  file(
    "course.yaml",
    "id: learning\ntitle: Learning\nslug: learning\nmodules:\n  - {id: basics, title: Basics, slug: basics, pages: [basics-intro]}\n  - {id: more, title: More, slug: more, pages: [more-intro]}\n",
  ),
  file("basics-intro.md", "---\nid: basics-intro\ntitle: Basics\nslug: intro\n---\n# Basics\n"),
  file("more-intro.md", "---\nid: more-intro\ntitle: More\nslug: intro\n---\n# More\n"),
];
const named = <T extends Resource["type"]>(desired: Resource[], type: T, name: string) =>
  desired.find((resource) => resource.type === type && resource.name === name) as Extract<
    Resource,
    { type: T }
  >;

test("moving a Course page into a module with a page of its slug is a route collision", async () => {
  const diagnostic = await refusal(course, (desired) => {
    const page = named(desired, "CoursePage", "more-intro");
    named(desired, "CourseModule", "more").spec.pages = [];
    named(desired, "CourseModule", "basics").spec.pages.push(page.name);
    page.spec.module = "basics";
    return ["CoursePage/more-intro", "CourseModule/more", "CourseModule/basics"].map(
      (resource) => ({ kind: "update", resource }),
    );
  });
  expect(diagnostic).toMatchObject({ code: "route-collision", resource: "CoursePage/more-intro" });
  expect(sourcePlanDiagnosticCategory(diagnostic!)).toBe("request");
});

test("two modules of a Course with one slug are a route collision", async () => {
  const diagnostic = await refusal(course, (desired) => {
    named(desired, "CourseModule", "more").spec.slug = "basics";
    return [{ kind: "update", resource: "CourseModule/more" }];
  });
  expect(diagnostic).toMatchObject({ code: "route-collision", resource: "CourseModule/more" });
});

const wiki = [
  file(
    ".topik.yaml",
    "version: 1\nnamespace: refusals\nsources: [{kind: wiki, config: wiki.yaml}]\n",
  ),
  file("wiki.yaml", "id: docs\ntitle: Docs\nnavigation: [home, other]\n"),
  file("home.md", "---\nid: home\n---\n# Home\n"),
  file("other.md", "---\nid: other\n---\n# Other\n"),
];

test("two Wiki pages on one route are a route collision", async () => {
  const diagnostic = await refusal(wiki, (desired) => {
    const navigation = named(desired, "Wiki", "docs").spec.navigation!;
    navigation[1] = { ...navigation[1], slug: "home" } as (typeof navigation)[number];
    return [{ kind: "update", resource: "Wiki/docs" }];
  });
  expect(diagnostic).toMatchObject({ code: "route-collision", resource: "Wiki/docs" });
});

test("navigation that cannot resolve otherwise is an invalid request, not an internal failure", async () => {
  const diagnostic = await refusal(wiki, (desired) => {
    const navigation = named(desired, "Wiki", "docs").spec.navigation!;
    (navigation as WikiNavNode[]).push({ ...navigation[0], slug: "again" } as WikiNavNode);
    return [{ kind: "update", resource: "Wiki/docs" }];
  });
  expect(diagnostic?.code).not.toBe("source-validation-failed");
  expect(sourcePlanDiagnosticCategory(diagnostic!)).not.toBe("internal");
});

test("new media named without a generated Asset name is refused", async () => {
  const project = await readSourceProject({ tree: wiki });
  const desired = structuredClone(project.compilation.resources);
  const name = "new-diagram";
  desired.push({
    apiVersion: "v1",
    type: "Asset",
    name,
    spec: {
      uri: `blobs/${sha256(PNG)}`,
      integrity: `sha256:${sha256(PNG)}`,
      size: PNG.length,
      mediaType: "image/png",
    },
  } as (typeof desired)[number]);
  const home = named(desired, "WikiPage", "home");
  home.spec.content.value += `\n![Diagram](asset:${name})\n`;
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "WikiPage/home" }],
    authority: { ...everything(project), create: ["_assets/new.png"] },
    media: [{ name, filename: "new.png", sha256: sha256(PNG), bytes: PNG, config: "wiki.yaml" }],
  });
  expect(result.ok ? [] : result.diagnostics).toMatchObject([
    { code: "asset-name-invalid", resource: `Asset/${name}` },
  ]);
  if (!result.ok) expect(sourcePlanDiagnosticCategory(result.diagnostics[0])).toBe("asset");
});

test("initialization refuses media without a generated Asset name", async () => {
  const project = await readSourceProject({ tree: wiki });
  const resources = structuredClone(project.compilation.resources);
  resources.push({
    apiVersion: "v1",
    type: "Asset",
    name: "new-diagram",
    spec: {
      uri: `blobs/${sha256(PNG)}`,
      integrity: `sha256:${sha256(PNG)}`,
      size: PNG.length,
      mediaType: "image/png",
    },
  } as (typeof resources)[number]);
  const result = await initializeSourceProject({
    tree: [],
    expectedTreeDigest: digestSourceTree([]),
    packageCohort: cohort,
    intent: {
      namespace: "refusals",
      source: { kind: "wiki", config: "wiki.yaml", id: "docs", title: "Docs" },
    },
    resources,
    media: [{ name: "new-diagram", filename: "new.png", sha256: sha256(PNG), bytes: PNG }],
    createPaths: [".topik.yaml", "wiki.yaml", "home.md", "other.md"],
  });
  expect(result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "asset-name-invalid",
  ]);
});
