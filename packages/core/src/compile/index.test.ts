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

  test("returns no resources when no supported config is present", async () => {
    await expect(compile({ dir })).resolves.toMatchObject({
      diagnostics: [],
      resources: [],
      payloads: [],
    });
  });

  test("delegates wiki directories to the wiki compiler", async () => {
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n");

    const result = await compile({ dir });

    expect(result.resources.map((resource) => resource.type)).toEqual(["Wiki", "WikiPage"]);
  });

  test("delegates collection directories to the guide compiler", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: blog\ntitle: Blog\n");
    await writeFile(join(dir, "post.md"), "# My Post\n");

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
    const result = await compile({
      dir,
      validation: { links: "off" },
      assets: { sourceNamespace: "protected-mixed-config" },
    });
    expect(result.resources.filter((resource) => resource.type === "Asset")).toEqual([]);
    expect(result.payloads).toEqual([]);
  });

  test("asset destination settings do not alter compiled resources or create source directories", async () => {
    const config = "id: docs\ntitle: Docs\nnavigation: [intro]\n";
    await writeFile(join(dir, "wiki.yaml"), config);
    await writeFile(join(dir, "intro.md"), "# Intro\n");
    const before = await compile({ dir });
    await writeFile(join(dir, "wiki.yaml"), config + "assets:\n  directory: media/uploads\n");
    expect(await compile({ dir })).toEqual(before);
    expect((await readdir(dir)).sort()).toEqual(["intro.md", "wiki.yaml"]);
  });
});
