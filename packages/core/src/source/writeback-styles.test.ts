import { expect, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import type { Wiki, WikiNavNode } from "@topik/schema/wiki/v1";
import {
  replaySourceByteEdits as publicReplay,
  verifySharedEdits as publicVerify,
  SourcePlanningError as PublicPlanningError,
  SourceTreeError as PublicTreeError,
} from "../index";
import { SourcePlanningError, SourceTreeError } from "./diagnostics";
import { initializeSourceProject } from "./initialize";
import { planSourceUpdates, verifySharedEdits, type SourceResourceOperation } from "./plan";
import { digestSourceTree, readSourceProject, type SourceProject } from "./project";
import {
  decodeSource,
  encodeSource,
  patchSourceFields,
  patchSourceSequence,
  replaySourceByteEdits,
} from "./syntax";
import type { Resource } from "../resource";

const cohort = "a".repeat(64);
const file = (path: string, raw: string) => ({
  path,
  mode: "100644" as const,
  bytes: encodeSource(raw),
});
const manifest = (kind: string, config: string) =>
  file(
    ".topik.yaml",
    `version: 1\nnamespace: styles\nsources: [{kind: ${kind}, config: ${config}}]\n`,
  );
const authority = (project: SourceProject, create: string[] = []) => ({
  resources: project.compilation.resources.map((resource) => `${resource.type}/${resource.name}`),
  exclusive: project.documents
    .filter((document) => /\.mdx?$/.test(document.path))
    .map(({ path, sha256, mode }) => ({ path, sha256, mode })),
  shared: project.configurations.filter((config) => config.path !== ".topik.yaml"),
  create,
});
async function plan(
  tree: ReturnType<typeof file>[],
  edit: (desired: Resource[]) => readonly SourceResourceOperation[],
  options: {
    create?: string[];
    shared?: (project: SourceProject) => ReturnType<typeof authority>["shared"];
    referenceContexts?: (desired: Resource[]) => Record<string, Wiki>;
  } = {},
) {
  const project = await readSourceProject({ tree });
  const desired = structuredClone(project.compilation.resources);
  const operations = edit(desired);
  const admitted = authority(project, options.create);
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: cohort,
    desiredResources: desired,
    operations,
    authority: {
      ...admitted,
      resources: [...admitted.resources, ...operations.map((operation) => operation.resource)],
      ...(options.shared ? { shared: options.shared(project) } : {}),
    },
    ...(options.referenceContexts ? { referenceContexts: options.referenceContexts(desired) } : {}),
  });
  const written = (path: string) =>
    result.ok
      ? decodeSource(result.plan.changes.find((change) => change.path === path)!.candidate!.bytes)
      : undefined;
  return { project, desired, result, written };
}
const guide = (desired: Resource[]) =>
  desired.find((resource): resource is Guide => resource.type === "Guide")!;
const collection = "id: blog\ntitle: Blog\nsourceVersion: 1\n";

test("block sequences at their key's column take an indented flow replacement", () => {
  for (const eol of ["\n", "\r\n"]) {
    const raw = "id: p\ntags:\n- a\n- b\ncustom: exact\n".replaceAll("\n", eol);
    const result = patchSourceFields(raw, { tags: ["y"] });
    expect(decodeSource(result.bytes)).toBe(
      'id: p\ntags:\n  ["y"]\ncustom: exact\n'.replaceAll("\n", eol),
    );
    expect(replaySourceByteEdits(encodeSource(raw), result.edits)).toEqual(result.bytes);
  }
  expect(decodeSource(patchSourceFields("tags: # keep\n- a\n", { tags: "one" }).bytes)).toBe(
    'tags: # keep\n  "one"\n',
  );
  expect(
    decodeSource(
      patchSourceFields("persons:\n- id: ada\n  tags:\n  - a\n", { "persons/ada/tags": [] }).bytes,
    ),
  ).toBe("persons:\n- id: ada\n  tags:\n    []\n");
  // Indented block sequences and item edits keep their original layout.
  expect(decodeSource(patchSourceFields("tags:\n  - a\n", { tags: ["y"] }).bytes)).toBe(
    'tags:\n  ["y"]\n',
  );
  expect(decodeSource(patchSourceFields("tags:\n- a\n- b\n", { "tags/1": "c" }).bytes)).toBe(
    'tags:\n- a\n- "c"\n',
  );
});

test("empty-valued keys take a separated value", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["title:\nid: x\n", { title: "T" }, 'title: "T"\nid: x\n'],
    ["title:\n", { title: "T" }, 'title: "T"\n'],
    ["title:", { title: "T" }, 'title: "T"'],
    ["title: # keep\nid: x\n", { title: "T" }, 'title: "T" # keep\nid: x\n'],
    [
      "labels:\n  role:\n  id: x\n",
      { "labels/role": "editor" },
      'labels:\n  role: "editor"\n  id: x\n',
    ],
    ["title: ~\n", { title: "T" }, 'title: "T"\n'],
  ];
  for (const [raw, updates, expected] of cases)
    expect(decodeSource(patchSourceFields(raw, updates).bytes)).toBe(expected);
});

test("removing every item of a block sequence at its key's column keeps an empty sequence", () => {
  const raw = "persons:\n- id: ann\n  spec:\n    name: Ann\ncustom: exact\n";
  const edits = patchSourceSequence(raw, "persons", [], ["persons/ann"]);
  expect(decodeSource(replaySourceByteEdits(encodeSource(raw), edits))).toBe(
    "persons:\n  []\ncustom: exact\n",
  );
  const indented = "persons:\n  - id: ann\n    spec: {name: Ann}\n";
  expect(
    decodeSource(
      replaySourceByteEdits(
        encodeSource(indented),
        patchSourceSequence(indented, "persons", [], ["persons/ann"]),
      ),
    ),
  ).toBe("persons:\n  []\n");
});

test("Guide metadata edits accept zero-indented sequences and empty values", async () => {
  const persons = "persons:\n- id: ann\n  spec: {name: Ann}\n- id: bob\n  spec: {name: Bob}\n";
  const tags = await plan(
    [
      manifest("collection", "collection.yaml"),
      file("collection.yaml", collection + persons),
      file(
        "post.md",
        "---\nid: p\nauthors:\n- ann\ntags:\n- a\n- b\ninheritTags: false\n---\n# Post\n",
      ),
    ],
    (desired) => {
      guide(desired).spec.tags = ["y"];
      guide(desired).spec.authors = ["bob"];
      return [{ kind: "update", resource: "Guide/p" }];
    },
  );
  expect(tags.result.ok, JSON.stringify(tags.result)).toBe(true);
  expect(tags.written("post.md")).toBe(
    '---\nid: p\nauthors:\n  ["bob"]\ntags:\n  ["y"]\ninheritTags: false\n---\n# Post\n',
  );
  const description = await plan(
    [
      manifest("collection", "collection.yaml"),
      file("collection.yaml", collection),
      file("post.md", "---\nid: p\ndescription:\n---\n# Post\n"),
    ],
    (desired) => {
      guide(desired).spec.description = "Hello";
      return [{ kind: "update", resource: "Guide/p" }];
    },
  );
  expect(description.result.ok, JSON.stringify(description.result)).toBe(true);
  expect(description.written("post.md")).toBe('---\nid: p\ndescription: "Hello"\n---\n# Post\n');
});

test("deleting the last record of a zero-indented list keeps valid configuration", async () => {
  const person = await plan(
    [
      manifest("collection", "collection.yaml"),
      file("collection.yaml", `${collection}persons:\n- id: ann\n  spec:\n    name: Ann\n`),
      file("post.md", "---\nid: p\n---\n# Post\n"),
    ],
    (desired) => {
      desired.splice(
        desired.findIndex((resource) => resource.type === "Person"),
        1,
      );
      return [{ kind: "delete", resource: "Person/ann" }];
    },
  );
  expect(person.result.ok, JSON.stringify(person.result)).toBe(true);
  expect(person.written("collection.yaml")).toBe(`${collection}persons:\n  []\n`);
  const course = await plan(
    [
      manifest("course", "course.yaml"),
      file(
        "course.yaml",
        "id: c\ntitle: C\nslug: c\nsourceVersion: 1\nmodules:\n- id: m\n  title: M\n  slug: m\n  pages:\n  - a\n",
      ),
      file("a.md", "---\nid: a\ntitle: A\nslug: a\n---\n# A\n"),
    ],
    (desired) => {
      desired.splice(
        desired.findIndex((resource) => resource.type === "CoursePage"),
        1,
      );
      const module = desired.find((resource) => resource.type === "CourseModule");
      if (module?.type === "CourseModule") module.spec.pages = [];
      return [
        { kind: "delete", resource: "CoursePage/a" },
        { kind: "update", resource: "CourseModule/m" },
      ];
    },
  );
  expect(course.result.ok, JSON.stringify(course.result)).toBe(true);
  expect(course.written("course.yaml")).toBe(
    "id: c\ntitle: C\nslug: c\nsourceVersion: 1\nmodules:\n- id: m\n  title: M\n  slug: m\n  pages:\n    []\n",
  );
});

test("moving a Course page file keeps its declaration position and comment", async () => {
  const config =
    "id: c\ntitle: C\nslug: c\nsourceVersion: 1\nmodules:\n  - id: m1\n    title: M1\n    slug: m1\n    pages:\n      - a # first\n      - b\n";
  const { project, result, written } = await plan(
    [
      manifest("course", "course.yaml"),
      file("course.yaml", config),
      file("a.md", "---\nid: a\ntitle: A\nslug: a\n---\n# A\n"),
      file("b.md", "---\nid: b\ntitle: B\nslug: b\n---\n# B\n"),
    ],
    () => [{ kind: "move", resource: "CoursePage/a", path: "lessons/a.md" }],
    { create: ["lessons/a.md"] },
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(written("course.yaml")).toBe(config.replace("- a # first", '- "lessons/a" # first'));
  // The move keeps the page's place in its module.
  const lists = (resources: readonly import("../resource").Resource[]) =>
    resources.flatMap((r) => (r.type === "CourseModule" ? [[r.name, r.spec.pages]] : []));
  expect(lists(result.plan.candidate.compilation.resources)).toEqual(
    lists(project.compilation.resources),
  );
  const shared = result.plan.changes.find((change) => change.path === "course.yaml")!.sharedEdits!;
  expect(shared.map((edit) => edit.selector)).toEqual(["modules/m1/pages/a"]);
});

const wiki = (navigation: string) => [
  manifest("wiki", "wiki.yaml"),
  file("wiki.yaml", `id: docs\ntitle: Docs\nsourceVersion: 1\n${navigation}`),
  file("home.md", "---\nid: home\n---\n# Home\n"),
  file("other.md", "---\nid: other\n---\n# Other\n"),
  file("third.md", "---\nid: third\n---\n# Third\n"),
];
const wikiOf = (desired: Resource[]) =>
  desired.find((resource): resource is Wiki => resource.type === "Wiki")!;
const deleteThird = (desired: Resource[]) => {
  desired.splice(
    desired.findIndex((resource) => resource.name === "third"),
    1,
  );
  const remove = (nodes: WikiNavNode[]): WikiNavNode[] =>
    nodes
      .filter((node) => node.type !== "page" || node.page !== "third")
      .map((node) =>
        "children" in node ? ({ ...node, children: remove(node.children) } as WikiNavNode) : node,
      );
  const wiki = wikiOf(desired);
  wiki.spec.navigation = remove(
    wiki.spec.navigation as WikiNavNode[],
  ) as typeof wiki.spec.navigation;
  return [
    { kind: "delete", resource: "WikiPage/third" },
    { kind: "update", resource: "Wiki/docs" },
  ] as const;
};

test.each([
  [
    "navigation:\n  - home\n  - other # keep\n  - third\n",
    "navigation:\n  - home\n  - other # keep\n",
  ],
  [
    "navigation:\n  - home\n  - third # remove\n  - other # keep\n",
    "navigation:\n  - home\n  - other # keep\n",
  ],
  ["navigation: [home, other, # keep\n  third]\n", "navigation: [home, other # keep\n  ]\n"],
  [
    "navigation:\n  - home\n  - type: group\n    title: Group # keep\n    children:\n      - other # keep\n      - third\n",
    "navigation:\n  - home\n  - type: group\n    title: Group # keep\n    children:\n      - other # keep\n",
  ],
])("deleting a Wiki page edits navigation items in place: %j", async (before, after) => {
  for (const narrow of [false, true]) {
    // Authority over the navigation value covers edits of its own items.
    const shared = (project: SourceProject) =>
      project.configurations
        .filter((config) => config.path === "wiki.yaml")
        .map((config) => ({
          ...config,
          fields: config.fields.filter((field) => field.selector === "navigation"),
        }));
    const { result, written } = await plan(wiki(before), deleteThird, narrow ? { shared } : {});
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(written("wiki.yaml")).toBe(`id: docs\ntitle: Docs\nsourceVersion: 1\n${after}`);
  }
});

test("creating a Wiki page appends one navigation item and keeps existing entries", async () => {
  const { result, written } = await plan(
    wiki("navigation:\n  - home\n  - other # keep\n  - third\n"),
    (desired) => {
      const third = desired.find((resource) => resource.name === "third")!;
      desired.push({
        ...structuredClone(third),
        name: "fourth",
        spec: {
          ...structuredClone((third as Extract<Resource, { type: "WikiPage" }>).spec),
          title: "Fourth",
          content: { format: "topik", value: "# Fourth\n" },
        },
      } as Resource);
      const page: WikiNavNode = { type: "page", page: "fourth", slug: "fourth" };
      (wikiOf(desired).spec.navigation as WikiNavNode[]).push(page);
      return [
        { kind: "create", resource: "WikiPage/fourth", config: "wiki.yaml" },
        { kind: "update", resource: "Wiki/docs" },
      ];
    },
    {
      create: ["fourth.md"],
      referenceContexts: (desired) => ({ "WikiPage/fourth": structuredClone(wikiOf(desired)) }),
    },
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(written("wiki.yaml")).toBe(
    'id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation:\n  - home\n  - other # keep\n  - third\n  - {"type":"page","slug":"fourth"}\n',
  );
});

test("frontmatter edits of the final key leave no blank line before the closing fence", async () => {
  for (const eol of ["\n", "\r\n"]) {
    const tree = (post: string) => [
      manifest("collection", "collection.yaml"),
      file("collection.yaml", collection),
      file("post.md", post.replaceAll("\n", eol)),
    ];
    const appended = await plan(tree("---\nid: p\n---\n# Post\n"), (desired) => {
      guide(desired).spec.tags = ["t"];
      return [{ kind: "update", resource: "Guide/p" }];
    });
    expect(appended.written("post.md")).toBe(
      '---\nid: p\ntags: ["t"]\ninheritTags: false\n---\n# Post\n'.replaceAll("\n", eol),
    );
    const removed = await plan(tree("---\nid: p\ndescription: D\n---\n# Post\n"), (desired) => {
      delete guide(desired).spec.description;
      return [{ kind: "update", resource: "Guide/p" }];
    });
    expect(removed.written("post.md")).toBe("---\nid: p\n---\n# Post\n".replaceAll("\n", eol));
  }
});

test("a guide in an included folder is updated in place; a path outside include is refused", async () => {
  const tree = [
    manifest("collection", "collection.yaml"),
    file("collection.yaml", `${collection}include: ["*.md", "basics/*.md"]\n`),
    file("basics/post.md", "---\nid: p\n---\n# Post\n"),
  ];
  const updated = await plan(tree, (desired) => {
    guide(desired).spec.tags = ["t"];
    return [{ kind: "update", resource: "Guide/p" }];
  });
  expect(updated.written("basics/post.md")).toBe(
    '---\nid: p\ntags: ["t"]\ninheritTags: false\n---\n# Post\n',
  );

  for (const [path, ok] of [
    ["basics/moved.md", true],
    ["advanced/moved.md", false],
    ["basics/CHANGELOG.md", false],
  ] as const) {
    const { result } = await plan(tree, () => [{ kind: "move", resource: "Guide/p", path }], {
      create: [path],
    });
    expect(result.ok).toBe(ok);
    if (!result.ok)
      expect(result.diagnostics).toEqual([
        {
          code: "source-path-invalid",
          message: "Guides must be files their declared collection configuration reads.",
          resource: "Guide/p",
        },
      ]);
  }
});

test("a left-out capital-named file beside a collection does not block planning", async () => {
  const { project, result, written } = await plan(
    [
      manifest("collection", "collection.yaml"),
      file("collection.yaml", collection),
      file("post.md", "---\nid: p\n---\n# Post\n"),
      file("FAQ.md", "<b>left out, with a warning</b>\n"),
    ],
    (desired) => {
      guide(desired).spec.tags = ["t"];
      return [{ kind: "update", resource: "Guide/p" }];
    },
  );
  expect(project.compilation.diagnostics.map(({ id, file }) => [id, file])).toEqual([
    ["guide-left-out", "FAQ.md"],
  ]);
  expect(result.ok).toBe(true);
  expect(written("post.md")).toContain('tags: ["t"]');
});

test("an explicit unportable move path is refused for its resource", async () => {
  const { result } = await plan(
    wiki("navigation: [home, other, third]\n"),
    () => [{ kind: "move", resource: "WikiPage/third", path: "docs/../../other.md" }],
    { create: ["docs/../../other.md"] },
  );
  expect(result).toEqual({
    ok: false,
    diagnostics: [
      {
        code: "source-path-invalid",
        message: "The requested source path is not a portable project path.",
        resource: "WikiPage/third",
      },
    ],
  });
});

test.each(["wiki", "course"] as const)(
  "%s initialization refuses an intent title that differs from the resource",
  async (kind) => {
    const project = await readSourceProject({
      tree:
        kind === "wiki"
          ? [
              manifest("wiki", "wiki.yaml"),
              file("wiki.yaml", "id: docs\ntitle: Docs\nsourceVersion: 1\nnavigation: [home]\n"),
              file("home.md", "---\nid: home\n---\n# Home\n"),
            ]
          : [
              manifest("course", "course.yaml"),
              file(
                "course.yaml",
                "id: docs\ntitle: Docs\nslug: docs\nsourceVersion: 1\nmodules:\n  - {id: m, title: M, slug: m, pages: [m/home]}\n",
              ),
              file("m/home.md", "---\nid: home\ntitle: Home\nslug: home\n---\n# Home\n"),
            ],
    });
    const request = (title: string) =>
      initializeSourceProject({
        tree: [],
        expectedTreeDigest: digestSourceTree([]),
        packageCohort: cohort,
        intent: {
          namespace: "styles/init",
          source: { kind, config: "docs/config.yaml", id: "docs", title },
        },
        resources: project.compilation.resources,
        createPaths: [".topik.yaml", "docs/config.yaml", "docs/home.md", "docs/m/home.md"],
      });
    expect(await request("Other")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "source-intent-mismatch" }],
    });
    const accepted = await request("Docs");
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  },
);

test("the coordinator replay and verification primitives are public", () => {
  expect(publicReplay).toBe(replaySourceByteEdits);
  expect(publicVerify).toBe(verifySharedEdits);
  expect(PublicPlanningError).toBe(SourcePlanningError);
  expect(PublicTreeError).toBe(SourceTreeError);
});
