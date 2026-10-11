import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vite-plus/test";
import { compileManifest } from "./manifest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
type Kind = "wiki" | "course" | "collection";
const page = (id: string, body: string) =>
  `---\nid: ${id}\ntitle: ${id}\nslug: ${id}\norder: 0\n---\n${body}`;
async function fixture(
  kind: Kind,
  landings: string[],
  body: string,
  extra: Record<string, string> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "topik-folder-links-"));
  roots.push(dir);
  const paths = [
    "home",
    "files",
    ...landings.map((path) => `files/${path.replace(/\.mdx?$/, "")}`),
  ];
  const config = {
    id: "docs",
    title: "Docs",
    sourceVersion: 1,
    ...(kind === "wiki"
      ? {
          navigation: paths.map((source, index) => ({
            type: "page",
            slug: `page-${index}`,
            source,
          })),
        }
      : kind === "course"
        ? {
            slug: "docs",
            modules: [{ id: "basics", title: "Basics", slug: "basics", order: 0, pages: paths }],
          }
        : {}),
  };
  const files = {
    ".topik.yaml": JSON.stringify({
      version: 1,
      namespace: "folders",
      sources: [
        { kind, config: "content/config.yaml" },
        ...(kind === "collection" && landings.length
          ? [{ kind, config: "content/files/collection.yaml" }]
          : []),
      ],
    }),
    "content/config.yaml": JSON.stringify(config),
    ...(kind === "collection" && landings.length
      ? { "content/files/collection.yaml": "id: landings\ntitle: Landings\nsourceVersion: 1\n" }
      : {}),
    "content/home.md": page("home", body),
    "content/files.md": page("sibling", "# Sibling\n"),
    "content/files/notes.txt": "This file does not declare a page.\n",
    ...Object.fromEntries(
      landings.map((path, index) => [
        `content/files/${path}`,
        page(`landing-${index}`, "# Landing\n"),
      ]),
    ),
    ...extra,
  };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), contents);
  }
  return dir;
}

test.each(
  (["wiki", "course", "collection"] as const).flatMap((kind) =>
    ["index.md", "index.mdx", "README.md", "README.mdx", "readme.md"].map((landing) => ({
      kind,
      landing,
    })),
  ),
)("$kind resolves declared $landing folder landings consistently", async ({ kind, landing }) => {
  const hrefs = [
    "./files",
    "./files/",
    "./%66iles///?view=%FF&view=full#landing",
    "/files/",
    "/files?view=full#landing",
    `./files/${landing}#landing`,
  ];
  const body =
    hrefs
      .map((href) => `[Folder](${href})\n\n{% card href="${href}" title="Folder" /%}`)
      .join("\n\n") + "\n\n[Sibling](./files.md#sibling)\n";
  const result = await compileManifest({ dir: await fixture(kind, [landing], body) });
  expect(result.diagnostics).toEqual([]);
  expect(result.references).toHaveLength(hrefs.length * 2 + 1);
  expect(
    result.references
      .slice(0, -1)
      .every(({ reference, status }) => reference.name === "landing-0" && status === "verified"),
  ).toBe(true);
  expect(result.references.at(-1)?.reference.name).toBe("sibling");
  expect(result.references[4].reference).toMatchObject({
    search: "?view=%FF&view=full",
    hash: "landing",
  });
  expect(result.payloads).toEqual([]);
});

test.each(
  (["wiki", "course", "collection"] as const).flatMap((kind) =>
    (["error", "warning", "off"] as const).flatMap((links) =>
      [false, true].map((ambiguous) => ({ kind, links, ambiguous })),
    ),
  ),
)(
  "$kind reports folder resolution with links=$links, ambiguous=$ambiguous",
  async ({ kind, links, ambiguous }) => {
    const dir = await fixture(
      kind,
      ambiguous ? ["index.md", "README.mdx"] : [],
      "[Folder](./files?view=full)\n\n[Explicit](./files/)\n",
    );
    const id = ambiguous ? "link-reference-ambiguous" : "link-page-not-found";
    if (links === "error") {
      await expect(compileManifest({ dir, validation: { links } })).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ id }), expect.objectContaining({ id })],
      });
    } else {
      const result = await compileManifest({ dir, validation: { links } });
      expect(result.diagnostics).toEqual(
        links === "off"
          ? []
          : [
              expect.objectContaining({ id, level: "warning" }),
              expect.objectContaining({ id, level: "warning" }),
            ],
      );
      expect(result.references).toEqual([]);
      expect(result.payloads).toEqual([]);
    }
  },
);

test.each(["wiki", "course", "collection"] as const)(
  "%s never auto-declares an external folder landing",
  async (kind) => {
    const dir = await fixture(kind, [], "[Undeclared](../outside/)\n", {
      "outside/README.md": page("outside", "# Outside\n"),
    });
    await expect(compileManifest({ dir })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "link-page-not-found" })],
    });
  },
);

test.each(["wiki", "course", "collection"] as const)(
  "%s validates landing headings and rejects missing explicit folders",
  async (kind) => {
    const dir = await fixture(
      kind,
      ["index.md"],
      "[Heading](./files/#absent)\n\n[Missing](./missing/)\n",
    );
    await expect(compileManifest({ dir })).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ id: "link-fragment-not-found" }),
        expect.objectContaining({ id: "link-page-not-found" }),
      ],
    });
  },
);

test("the canonical Wiki root route need not use a root index source file", async () => {
  const dir = await fixture("wiki", [], "# Home\n\n[Home](/?view=full#home)\n");
  await writeFile(
    join(dir, "content/config.yaml"),
    JSON.stringify({
      id: "docs",
      title: "Docs",
      sourceVersion: 1,
      navigation: [{ type: "page", slug: "index", source: "home" }],
    }),
  );
  const result = await compileManifest({ dir });
  expect(result.diagnostics).toEqual([]);
  expect(result.references).toEqual([
    expect.objectContaining({
      status: "verified",
      reference: expect.objectContaining({ name: "home", search: "?view=full", hash: "home" }),
    }),
  ]);
});

test("Guide browser routes and external URLs retain their distinct contract", async () => {
  const body =
    "[App](/app/settings/)\n\n[Site](https://example.com/files/)\n\n[Mail](mailto:reader@example.com)\n";
  const result = await compileManifest({ dir: await fixture("collection", [], body) });
  expect(result.diagnostics).toEqual([]);
  expect(result.references).toEqual([]);
  expect(result.resources.find((resource) => resource.name === "home")?.spec).toMatchObject({
    content: { value: body },
  });
});

test("a trailing slash does not turn a real download into folder content", async () => {
  const dir = await fixture("collection", [], "[Folder](./download/)\n", {
    "content/download": "Download bytes.\n",
  });
  await expect(compileManifest({ dir })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ id: "link-page-not-found" })],
  });
});

test.each(["wiki", "course"] as const)(
  "%s ignores undeclared competing landing files",
  async (kind) => {
    const dir = await fixture(kind, ["index.md"], "[Folder](./files/)\n", {
      "content/files/README.md": page("undeclared", "# Undeclared\n"),
    });
    const result = await compileManifest({ dir });
    expect(result.references).toMatchObject([{ reference: { name: "landing-0" } }]);
    expect(result.resources.some(({ name }) => name === "undeclared")).toBe(false);
  },
);

test("Guide landing ambiguity counts independently declared Markdown extensions", async () => {
  const dir = await fixture("collection", ["index.md", "index.mdx"], "[Folder](./files/)\n");
  await expect(compileManifest({ dir })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ id: "link-reference-ambiguous" })],
  });
});

test.each(["wiki", "course", "collection"] as const)(
  "%s rejects folder paths escaping the project",
  async (kind) => {
    const dir = await fixture(
      kind,
      ["index.md"],
      "[Escape](../../files/)\n\n[Encoded](%2e%2e/%2e%2e/files/)\n",
    );
    await expect(compileManifest({ dir })).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ id: "link-page-not-found" }),
        expect.objectContaining({ id: "link-page-not-found" }),
      ],
    });
  },
);
