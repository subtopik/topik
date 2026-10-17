import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vite-plus/test";
import { compileWiki } from "./wiki";
import { createProjectAssetNameGenerator } from "./asset-names";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(body: string, extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "topik-wiki-dotted-"));
  roots.push(dir);
  const files = {
    "wiki.yaml": JSON.stringify({
      id: "docs",
      title: "Docs",
      sourceVersion: 1,
      navigation: [
        { type: "page", slug: "index", source: "home" },
        { type: "page", slug: "next", source: "next.json" },
        ...(extra["next.json/index.md"]
          ? [{ type: "page", slug: "landing", source: "next.json/index" }]
          : []),
      ],
    }),
    "home.md": `---\nid: home\n---\n# Home\n\n${body}\n`,
    "next.json.md": "---\nid: next-page\n---\n# Next\n",
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}
const both = (href: string) => `[Next](${href})\n\n{% card title="Next" href="${href}" /%}`;

test("Wiki dotted source links and cards preserve query and fragment", async () => {
  const href = "./next.json?view=full#next";
  const dir = await fixture(both(href));
  const result = await compileWiki({ dir });
  expect(result.diagnostics).toEqual([]);
  expect(result.references).toMatchObject([
    {
      kind: "link",
      href,
      reference: { name: "next-page", search: "?view=full", hash: "next" },
      status: "verified",
    },
    {
      kind: "card",
      href,
      reference: { name: "next-page", search: "?view=full", hash: "next" },
      status: "verified",
    },
  ]);
  expect(result.payloads).toEqual([]);
});

test("Wiki dotted downloads retain link precedence while cards select pages", async () => {
  const dir = await fixture(both("./next.json"), { "next.json": "{}\n" });
  const result = await compileWiki({
    dir,
    assets: {
      generateName: createProjectAssetNameGenerator({
        projectRoot: dir,
        projectNamespace: "example/dotted",
      }),
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.references).toMatchObject([{ kind: "card", reference: { name: "next-page" } }]);
  expect(result.references).toHaveLength(1);
  expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
  expect(new TextDecoder().decode(result.payloads[0].bytes)).toBe("{}\n");
  await rm(join(dir, "next.json"));
  const outside = await mkdtemp(join(tmpdir(), "topik-wiki-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "secret"), "Private bytes");
  await symlink(join(outside, "secret"), join(dir, "next.json"));
  await expect(compileWiki({ dir })).rejects.toMatchObject({
    name: "AssetCompilationError",
    diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" })],
  });
});

test("Wiki dotted folders select their declared landing before same-stem pages", async () => {
  const dir = await fixture(
    `${both("./next.json?view=full#next")}\n\n[File](./next.json.md#next)`,
    {
      "next.json/index.md": "---\nid: landing\n---\n# Next\n",
    },
  );
  const result = await compileWiki({ dir });
  expect(result.diagnostics).toEqual([]);
  expect(result.references.map(({ reference }) => reference.name)).toEqual([
    "landing",
    "landing",
    "next-page",
  ]);
});

test("Wiki dotted fallback preserves root routes and rejects escaping and missing folders", async () => {
  const dir = await fixture(
    [both("/#home"), both("./next.json/"), both("../next.json"), both("/../")].join("\n\n"),
  );
  const result = await compileWiki({ dir, validation: { links: "warning" } });
  expect(result.references.map(({ reference }) => reference.name)).toEqual(["home", "home"]);
  expect(result.diagnostics).toHaveLength(6);
  expect(result.diagnostics.every(({ id }) => id === "link-page-not-found")).toBe(true);
});
