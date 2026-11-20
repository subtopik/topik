import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { compileCourse } from "./course";
import { compileManifest } from "./manifest";
import { compileResourceLinks } from "./links";
import { validateResources } from "../validate";
import { analyzeTopikContent } from "@topik/content";

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
      content: { value: expect.stringContaining("ref://course-page/next?mode=full#details") },
    },
  });
  const page = result.resources.find(
    (resource) => resource.type === "CoursePage" && resource.name === "welcome",
  )!;
  if (page.type !== "CoursePage") throw new Error("Expected a Course page");
  expect(analyzeTopikContent(page.spec.content.value).links.map(({ href }) => href)).toEqual([
    "ref://course-page/next?mode=full#details",
    "ref://course-page/next#details",
    "#welcome",
  ]);
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
    spec: {
      content: { value: expect.stringContaining("ref://course-page/next?mode=full#details") },
    },
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

test("same-page card fragments are checked like same-page link fragments", async () => {
  const cards = [
    '{% card title="Self" href="#welcome" /%}',
    '{% card title="Missing" href="#absent" /%}',
    '{% card title="Second step" href="#step-1" /%}',
    "## Step",
    "## Step",
  ].join("\n\n");
  const dir = await fixture({ ...sourceFiles(), "pages/welcome.md": `${welcome}\n${cards}\n` });
  await expect(compileCourse({ dir })).rejects.toMatchObject({
    diagnostics: [
      expect.objectContaining({
        id: "link-fragment-not-found",
        type: "card",
        file: "pages/welcome.md",
      }),
    ],
  });
  const warned = await compileCourse({ dir, validation: { links: "warning" } });
  expect(warned.diagnostics.map(({ id, lines }) => [id, lines])).toEqual([
    // Lines count from the top of the file, including the nine frontmatter lines.
    ["link-fragment-not-found", [18]],
    ["link-fragment-positional", [20]],
  ]);
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
  // The second page is named, with the field and the page it collides with.
  await expect(compileCourse({ dir })).rejects.toMatchObject({
    id: "frontmatter-invalid",
    location: "separate/next.md",
    field: "id",
    relatedLocation: "pages/welcome.md",
  });
  await writeFile(
    join(dir, "separate/next.md"),
    next.replace("slug: destination", "slug: introduction"),
  );
  await expect(compileCourse({ dir })).rejects.toMatchObject({
    id: "frontmatter-invalid",
    location: "separate/next.md",
    field: "slug",
    relatedLocation: "pages/welcome.md",
  });
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

test("transports authored module/page indices independently from sorted resources", async () => {
  const config = {
    sourceVersion: 1,
    id: "learning",
    title: "Learning",
    slug: "learning",
    modules: [
      { id: "z-module", title: "Z", slug: "z", order: 0, pages: ["z", "a"] },
      { id: "a-module", title: "A", slug: "a", order: 0, pages: [] },
    ],
  };
  const dir = await fixture({
    "course.yaml": JSON.stringify(config),
    ".topik.yaml": JSON.stringify({
      version: 1,
      namespace: "ordering",
      sources: [{ kind: "course", config: "course.yaml" }],
    }),
    "z.md": "---\nid: z-page\ntitle: Z\nslug: z\norder: 0\n---\n# Z\n",
    "a.md": "---\nid: a-page\ntitle: A\nslug: a\norder: 0\n---\n# A\n",
  });
  const before = await compileManifest({ dir });
  const standalone = await compileCourse({ dir });
  const { discoverCourseResources } = await import("./discovery");
  expect((await discoverCourseResources({ dir })).courseNavigation).toEqual(
    before.courseNavigation,
  );
  expect(standalone.courseNavigation).toEqual(before.courseNavigation);
  expect(before.courseNavigation.learning.modules).toEqual([
    {
      name: "z-module",
      declarationIndex: 0,
      pages: [
        { name: "z-page", declarationIndex: 0 },
        { name: "a-page", declarationIndex: 1 },
      ],
    },
    { name: "a-module", declarationIndex: 1, pages: [] },
  ]);
  config.modules[0].pages.reverse();
  config.modules.reverse();
  await writeFile(join(dir, "course.yaml"), JSON.stringify(config));
  const after = await compileManifest({ dir });
  expect(after.resources).toEqual(before.resources);
  expect(after.courseNavigation).not.toEqual(before.courseNavigation);
  expect(after.courseNavigation.learning.modules[1].pages[0]).toEqual({
    name: "a-page",
    declarationIndex: 0,
  });
});

test("Course failures name the invalid field and reject invalid UTF-8 pages", async () => {
  let dir = await fixture({
    ...sourceFiles(),
    "course.yaml": `${configuration}${persons}modlues: []\n`,
  });
  await expect(compileCourse({ dir })).rejects.toMatchObject({
    id: "config-field-unknown",
    location: "course.yaml",
    field: "modlues",
  });

  dir = await fixture({
    ...sourceFiles(),
    "pages/welcome.md": welcome.replace("order: 12", "order: -1"),
  });
  await expect(compileCourse({ dir })).rejects.toMatchObject({
    id: "frontmatter-invalid",
    location: "pages/welcome.md",
    field: "order",
  });

  dir = await fixture({ ...sourceFiles(), "pages/welcome.md": Buffer.from([0x23, 0x20, 0xff]) });
  await expect(compileCourse({ dir })).rejects.toMatchObject({
    id: "document-encoding-invalid",
    location: "pages/welcome.md",
  });
});

test("link compilation skips a CoursePage that has no source-path binding", async () => {
  const dir = await fixture({});
  const result = await compileResourceLinks({
    rootDir: dir,
    resources: [
      { apiVersion: "v1", type: "Course", name: "c", spec: { title: "C", slug: "c" } },
      {
        apiVersion: "v1",
        type: "CourseModule",
        name: "m",
        spec: { course: "c", title: "M", slug: "m", order: 0 },
      },
      {
        apiVersion: "v1",
        type: "CoursePage",
        name: "p",
        spec: {
          module: "m",
          title: "P",
          slug: "p",
          order: 0,
          content: { format: "topik", value: "# P\n" },
        },
      },
    ],
    sourcePathsByResource: {},
  });
  expect(result.resources).toHaveLength(3);
  expect(result.diagnostics).toEqual([]);
});

test("a Course page description compiles as written, including an explicit null, and is bounded", async () => {
  const page = (id: string, extra: string) =>
    `---\nid: ${id}\ntitle: ${id}\nslug: ${id}\norder: 0\n${extra}---\n# ${id}\n`;
  const config = JSON.stringify({
    sourceVersion: 1,
    id: "learning",
    title: "Learning",
    slug: "learning",
    modules: [
      { id: "m", title: "M", slug: "m", order: 0, pages: ["described", "cleared", "plain"] },
    ],
  });
  const dir = await fixture({
    "course.yaml": config,
    "described.md": page("described", "description: What this lesson covers.\n"),
    "cleared.md": page("cleared", "description: null\n"),
    "plain.md": page("plain", ""),
  });
  const result = await compileCourse({ dir });
  expect(validateResources(result.resources).valid).toBe(true);
  const spec = (name: string) => {
    const resource = result.resources.find(
      (candidate) => candidate.type === "CoursePage" && candidate.name === name,
    )!;
    if (resource.type !== "CoursePage") throw new Error("Expected a Course page");
    return resource.spec;
  };
  expect(spec("described").description).toBe("What this lesson covers.");
  expect(spec("cleared").description).toBeNull();
  expect(Object.hasOwn(spec("plain"), "description")).toBe(false);

  for (const invalid of [`description: ${"a".repeat(1025)}\n`, "description: 42\n"]) {
    const broken = await fixture({
      "course.yaml": config,
      "described.md": page("described", invalid),
      "cleared.md": page("cleared", ""),
      "plain.md": page("plain", ""),
    });
    await expect(compileCourse({ dir: broken })).rejects.toMatchObject({
      id: "frontmatter-invalid",
      location: "described.md",
      field: "description",
    });
  }
});
