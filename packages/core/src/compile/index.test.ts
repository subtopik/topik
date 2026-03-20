import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    await expect(compile({ dir })).resolves.toEqual({ resources: [] });
  });

  test("delegates wiki directories to the wiki compiler", async () => {
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n");

    const result = await compile({ dir });

    expect(result.resources.map((resource) => resource.type)).toEqual(["WikiPage", "Wiki"]);
  });

  test("delegates collection directories to the guide compiler", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: blog\ntitle: Blog\n");
    await writeFile(join(dir, "post.md"), "# My Post\n");

    const result = await compile({ dir });

    expect(result.resources.map((resource) => resource.type)).toEqual(["Guide"]);
  });
});
