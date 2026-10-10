import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { compileCourse } from "./course";
import { compileManifest } from "./manifest";
import { validateResources } from "../validate";

const roots: string[] = [];
async function fixture(files: Record<string, string | Buffer>) {
  const dir = await mkdtemp(join(tmpdir(), "topik-course-"));
  roots.push(dir);
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), bytes);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const configuration = `sourceVersion: 1
id: learning
title: Learning
slug: public-course
description: null
labels: { audience: students }
authors: [alice]
modules:
  - id: basics
    title: Basics
    slug: getting-started
    order: 7
    description: null
    labels: { kind: intro }
    pages: [pages/welcome, separate/next]
`;
const persons = `persons:
  - id: alice
    labels: { role: author }
    spec: { name: Alice }
`;
const welcome = `---
id: welcome
title: Welcome
slug: introduction
order: 12
labels: { level: beginner }
authors: [alice]
opaque: retained
---
# Welcome

[Next](../separate/next.md?mode=full#details)
[Route](/getting-started/destination#details)
[Self](#welcome)
`;
const next = `---
id: next
title: Next
slug: destination
order: 4
authors: []
---
# Next

## Details
`;
function sourceFiles() {
  return {
    "course.yaml": configuration + persons,
    "pages/welcome.md": welcome,
    "separate/next.md": next,
  };
}

test("compiles the complete Course graph with exact identities, ordering, nullable metadata and independent source routes", async () => {
  const dir = await fixture(sourceFiles());
  const result = await compileCourse({ dir });
  expect(validateResources(result.resources).valid).toBe(true);
  expect(result.diagnostics).toEqual([]);
  expect(result.resources.find((resource) => resource.type === "Course")).toMatchObject({
    name: "learning",
    labels: { audience: "students" },
    spec: { slug: "public-course", authors: ["alice"], description: null },
  });
  expect(result.resources.find((resource) => resource.type === "CourseModule")).toMatchObject({
    name: "basics",
    labels: { kind: "intro" },
    spec: { course: "learning", order: 7, slug: "getting-started", description: null },
  });
  expect(
    result.resources.find(
      (resource) => resource.type === "CoursePage" && resource.name === "welcome",
    ),
  ).toMatchObject({
    labels: { level: "beginner" },
    spec: {
      module: "basics",
      order: 12,
      authors: ["alice"],
      content: { value: welcome.split("---\n")[2] },
    },
  });
  expect(
    result.resources.find((resource) => resource.type === "CoursePage" && resource.name === "next"),
  ).toMatchObject({ spec: { authors: [] } });
});

test("manifest Course sources use exact configuration, full project author closure and project-wide shared media identity", async () => {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  const dir = await fixture({
    ".topik.yaml": JSON.stringify({
      version: 1,
      namespace: "example/project",
      sources: [
        { kind: "course", config: "docs/custom.yaml" },
        { kind: "collection", config: "docs/collection.yaml" },
      ],
    }),
    "docs/custom.yaml": configuration,
    "docs/course.yaml": "invalid fallback",
    "docs/collection.yaml": "sourceVersion: 1\nid: shared\ntitle: Shared\n" + persons,
    "docs/pages/welcome.md": welcome + "\n![Shared](../logo.png)\n[Download](../download.pdf)\n",
    "docs/separate/next.md": next,
    "docs/guide.md": "# Guide\n![Shared](logo.png)\n",
    "docs/logo.png": png,
    "docs/download.pdf": Buffer.from("%PDF-1.7\nportable download\n%%EOF"),
  });
  const result = await compileManifest({ dir });
  expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(2);
  expect(result.semantic.references).toHaveLength(3);
  expect(result.provenance[0].sourcePathsByResource).toMatchObject({
    "Course/learning": "docs/custom.yaml",
    "CourseModule/basics": "docs/custom.yaml",
    "CoursePage/welcome": "docs/pages/welcome.md",
  });
  expect(
    result.resources.find(
      (resource) => resource.type === "CoursePage" && resource.name === "welcome",
    ),
  ).toMatchObject({ spec: { content: { value: expect.stringContaining("asset:") } } });
  await expect(compileCourse({ dir, configFile: "docs/custom.yaml" })).rejects.toMatchObject({
    id: "author-not-found",
  });
});

test("Course source files with literal hash characters compile relative links with separate query and fragment meaning", async () => {
  const dir = await fixture({
    "course.yaml": (configuration + persons).replace(
      "pages/welcome, separate/next",
      "part#1/welcome#file, part#1/next",
    ),
    "part#1/welcome#file.md": welcome.replace("../separate/next.md", "./next.md"),
    "part#1/next.md": next,
  });
  const result = await compileCourse({ dir });
  expect(result.diagnostics).toEqual([]);
  expect(
    result.resources.find(
      (resource) => resource.type === "CoursePage" && resource.name === "welcome",
    ),
  ).toMatchObject({
    spec: { content: { value: expect.stringContaining("./next.md?mode=full#details") } },
  });
});

test("unresolved page and fragment links retain strict, warning and disabled validation policies", async () => {
  const dir = await fixture({
    ...sourceFiles(),
    "pages/welcome.md":
      welcome + "\n[Missing](missing.md)\n[Missing heading](../separate/next.md#absent)\n",
  });
  await expect(compileCourse({ dir })).rejects.toMatchObject({
    diagnostics: [
      expect.objectContaining({ id: "link-page-not-found", file: "pages/welcome.md" }),
      expect.objectContaining({ id: "link-fragment-not-found", file: "pages/welcome.md" }),
    ],
  });
  const warned = await compileCourse({ dir, validation: { links: "warning" } });
  expect(warned.diagnostics.map((diagnostic) => diagnostic.level)).toEqual(["warning", "warning"]);
  expect((await compileCourse({ dir, validation: { links: "off" } })).diagnostics).toEqual([]);
});

test("author references reject missing Persons for Course and CoursePage metadata", async () => {
  const dir = await fixture({ ...sourceFiles(), "course.yaml": configuration });
  await expect(compileCourse({ dir })).rejects.toMatchObject({ id: "author-not-found" });
  await writeFile(
    join(dir, "course.yaml"),
    configuration.replace("authors: [alice]", "authors: []"),
  );
  await expect(compileCourse({ dir })).rejects.toMatchObject({
    id: "author-not-found",
    location: "pages/welcome.md",
  });
});

test("rejects duplicate Course page identities and routes independently of their file locations", async () => {
  const dir = await fixture({
    ...sourceFiles(),
    "separate/next.md": next.replace("id: next", "id: welcome"),
  });
  await expect(compileCourse({ dir })).rejects.toMatchObject({ id: "config-invalid" });
  await writeFile(
    join(dir, "separate/next.md"),
    next.replace("slug: destination", "slug: introduction"),
  );
  await expect(compileCourse({ dir })).rejects.toMatchObject({ id: "config-invalid" });
});

test("explicit Course page sources refuse ambiguous extensions and symlink traversal", async () => {
  const dir = await fixture({ ...sourceFiles(), "separate/next.mdx": next });
  await expect(compileCourse({ dir })).rejects.toMatchObject({ id: "course-page-ambiguous" });
  await rm(join(dir, "separate/next.mdx"));
  await rm(join(dir, "separate/next.md"));
  await symlink("../pages/welcome.md", join(dir, "separate/next.md"));
  await expect(compileCourse({ dir })).rejects.toMatchObject({ id: "file-not-regular" });
});

test("Course configurations reject unsafe aliases, repeated memberships, traversal and invalid stable metadata", async () => {
  const dir = await fixture(sourceFiles());
  for (const raw of [
    configuration.replace("sourceVersion: 1", "sourceVersion: 2"),
    configuration.replace("pages/welcome, separate/next", "pages/welcome, pages/welcome"),
    configuration.replace("pages/welcome, separate/next", "Pages/welcome, pages/other"),
    configuration.replace("pages/welcome, separate/next", "../outside"),
    configuration.replace("pages/welcome, separate/next", "&p [pages/welcome, *p]"),
  ]) {
    await writeFile(join(dir, "course.yaml"), raw);
    await expect(compileCourse({ dir })).rejects.toBeDefined();
  }
  await writeFile(join(dir, "course.yaml"), configuration + persons);
  await writeFile(join(dir, "pages/welcome.md"), welcome.replace("order: 12", "order: -1"));
  await expect(compileCourse({ dir })).rejects.toMatchObject({
    id: "frontmatter-invalid",
    location: "pages/welcome.md",
  });
});
