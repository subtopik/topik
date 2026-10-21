import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  analyzeTopikContent,
  compileTopikContent,
  extractTopikAssetOccurrences,
} from "@topik/content";
import { compileWiki, pagePathToName } from "./wiki";
import { createProjectAssetNameGenerator } from "./asset-names";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "topik-writer-boundaries-"));
  roots.push(dir);
  await Promise.all([
    writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - home\n  - next\n"),
    writeFile(join(dir, "home.md"), `# Home\n\n${body}`),
    writeFile(join(dir, "next.md"), "# Next\n\nDestination."),
    writeFile(
      join(dir, "photo.png"),
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
        "hex",
      ),
    ),
  ]);
  return dir;
}

test.each([false, true])(
  "compiles image alt blank lines with internal navigation (reference=%s)",
  async (reference) => {
    const image = reference
      ? "![before&#10;&#10;after][photo]\n\n[photo]: ./photo.png"
      : "![before&#10;&#10;after](./photo.png)";
    const dir = await fixture(`${image}\n\n[Next](./next.md)`);
    const result = await compileWiki({
      dir,
      assets: {
        generateName: createProjectAssetNameGenerator({
          projectRoot: dir,
          projectNamespace: "writer",
        }),
      },
    });
    expect(result.diagnostics).toEqual([]);
    const page = result.resources.find(
      (resource) =>
        resource.type === "WikiPage" && resource.name === pagePathToName("docs", "home"),
    );
    if (page?.type !== "WikiPage") throw new Error("Missing home page");
    const content = page.spec.content.value;
    expect(compileTopikContent(content).ok).toBe(true);
    expect(
      analyzeTopikContent(content).links.some(
        (link) => link.href === `ref://wiki-page/${pagePathToName("docs", "next")}`,
      ),
    ).toBe(true);
    const assets = extractTopikAssetOccurrences(content);
    expect(assets).toHaveLength(1);
    expect(assets[0].semantics.alt).toBe("before\n\nafter");
    expect(assets[0].reference).toMatch(/^asset:auto-v1-/);
    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
  },
);

test.each([1, 3])(
  "compiles table navigation references with %i backslashes before a pipe",
  async (slashes) => {
    const label = `a${"\\".repeat(slashes)}|b`;
    const dir = await fixture(
      `[${label}]: ./next.md\n\n| Destination |\n|---|\n| [Next][${label}] |`,
    );
    const result = await compileWiki({
      dir,
      assets: {
        generateName: createProjectAssetNameGenerator({
          projectRoot: dir,
          projectNamespace: "writer",
        }),
      },
    });
    expect(result.diagnostics).toEqual([]);
    const page = result.resources.find(
      (resource) =>
        resource.type === "WikiPage" && resource.name === pagePathToName("docs", "home"),
    );
    if (page?.type !== "WikiPage") throw new Error("Missing home page");
    expect(compileTopikContent(page.spec.content.value).ok).toBe(true);
    expect(analyzeTopikContent(page.spec.content.value).links.map((link) => link.href)).toEqual([
      `ref://wiki-page/${pagePathToName("docs", "next")}`,
    ]);
    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(0);
  },
);
