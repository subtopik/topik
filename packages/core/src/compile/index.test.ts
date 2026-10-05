import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { compile } from "./index";

describe("compile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-compile-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("requires a manifest instead of discovering conventional configs", async () => {
    await expect(compile({ dir })).rejects.toMatchObject({ id: "manifest-required" });
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs");
    await expect(compile({ dir })).rejects.toMatchObject({ id: "manifest-required" });
  });
  async function manifest(kinds: string[]) {
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "test/project",
        sources: kinds.map((kind) => ({ kind, config: kind + ".yaml" })),
      }),
    );
  }

  test("delegates wiki directories to the wiki compiler", async () => {
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n");

    await manifest(["wiki"]);
    const result = await compile({ dir });

    expect(result.resources.map((resource) => resource.type)).toEqual(["Wiki", "WikiPage"]);
  });

  test("delegates collection directories to the guide compiler", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: blog\ntitle: Blog\n");
    await writeFile(join(dir, "post.md"), "# My Post\n");

    await manifest(["collection"]);
    const result = await compile({ dir });

    expect(result.resources.map((resource) => resource.type)).toEqual(["Guide"]);
  });

  test("protects every consumed config source in mixed compilation", async () => {
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await writeFile(join(dir, "collection.yaml"), "id: blog\ntitle: Blog\n");
    await writeFile(
      join(dir, "intro.md"),
      "[Wiki configuration](wiki.yaml)\n\n[Collection configuration](collection.yaml)\n",
    );
    await manifest(["wiki", "collection"]);
    const result = await compile({
      dir,
      validation: { links: "off" },
    });
    expect(result.resources.filter((resource) => resource.type === "Asset")).toEqual([]);
    expect(result.payloads).toEqual([]);
  });

  test("asset destination settings do not alter compiled resources or create source directories", async () => {
    const config = "id: docs\ntitle: Docs\nnavigation: [intro]\n";
    await writeFile(join(dir, "wiki.yaml"), config);
    await writeFile(join(dir, "intro.md"), "# Intro\n");
    await manifest(["wiki"]);
    const before = await compile({ dir });
    await writeFile(join(dir, "wiki.yaml"), config + "assets:\n  directory: media/uploads\n");
    expect((await compile({ dir })).resources).toEqual(before.resources);
    expect((await readdir(dir)).sort()).toEqual([".topik.yaml", "intro.md", "wiki.yaml"]);
  });
});
