import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { runMintlify } from "./runner";

describe("runMintlify", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-codemod-runner-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("counts a pure rename (no content change) as a changed file", async () => {
    await writeFile(join(dir, "intro.mdx"), "# Intro\n\nNo Mintlify tags.\n");
    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
    expect(summary.filesChanged).toBe(1);
    const entries = await readdir(dir);
    expect(entries).toContain("intro.md");
    expect(entries).not.toContain("intro.mdx");
  });

  test("skips rename when destination already exists", async () => {
    await writeFile(join(dir, "page.mdx"), "# Hi\n");
    await writeFile(join(dir, "page.md"), "# Existing\n");

    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
    const file = summary.files.find((f) => f.relativePath === "page.mdx");
    expect(file?.error).toMatch(/already exists/);

    const existing = await readFile(join(dir, "page.md"), "utf-8");
    expect(existing).toBe("# Existing\n");
  });

  test("does not write or rename in dry-run mode", async () => {
    await writeFile(join(dir, "post.mdx"), "<Note>hi</Note>\n");
    const summary = await runMintlify({ dir, dryRun: true, keepExtension: false });
    expect(summary.filesChanged).toBe(1);
    const entries = await readdir(dir);
    expect(entries).toContain("post.mdx");
    expect(entries).not.toContain("post.md");
    const original = await readFile(join(dir, "post.mdx"), "utf-8");
    expect(original).toBe("<Note>hi</Note>\n");
  });
});
