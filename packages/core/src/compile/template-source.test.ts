import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { analyzeTopikContent, extractTopikAssetOccurrences } from "@topik/content";
import type { Guide } from "@topik/schema/guide/v1";
import { createProjectAssetNameGenerator } from "./asset-names";
import { compileGuides } from "./guide";

const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

describe("compiled resource template source", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-template-source-"));
    await writeFile(join(dir, "collection.yaml"), "id: examples\ntitle: Examples\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("preserves unevaluated templates while rewriting only static assets and validating links", async () => {
    const source = [
      "---",
      "title: Installation",
      "---",
      "# Install",
      "",
      "[Overview](#install)",
      "",
      '{% callout title=t"Install {% $package.name %}" %}',
      "Choose the matching version.",
      "{% /callout %}",
      "",
      '{% figure src="hero.png" alt=t"{% $package.name %}" caption=t"[Literal](missing.png)" /%}',
      "",
      "{% if $showInstall %}",
      "{% template code %}",
      "```sh",
      "npm install {% $package.name %}@{% $package.version %}",
      "![Literal](missing.png)",
      "[Literal](#missing)",
      "{%% $literal.path %}",
      "```",
      "{% /template code %}",
      "{% else /%}",
      '{% callout title=t"{% $unprovided.name %}" %}',
      "Alternative installation instructions.",
      "{% /callout %}",
      "{% /if %}",
      "",
    ].join("\n");
    await writeFile(join(dir, "install.md"), source);
    await writeFile(join(dir, "hero.png"), png);

    const result = await compileGuides({
      dir,
      assets: {
        generateName: createProjectAssetNameGenerator({
          projectRoot: dir,
          projectNamespace: "template-examples",
        }),
      },
    });
    const guide = result.resources.find((resource): resource is Guide => resource.type === "Guide");
    const asset = result.resources.find((resource) => resource.type === "Asset");
    const stored = guide?.spec.content.value ?? "";

    expect(result.diagnostics).toEqual([]);
    expect(guide?.spec.title).toBe("Installation");
    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
    expect(result.payloads).toHaveLength(1);
    expect(stored).toContain(`src="asset:${asset?.name}"`);
    expect(stored).toContain('title=t"Install {% $package.name %}"');
    expect(stored).toContain('alt=t"{% $package.name %}"');
    expect(stored).toContain('caption=t"[Literal](missing.png)"');
    expect(stored).toContain("npm install {% $package.name %}@{% $package.version %}");
    expect(stored).toContain("{%% $literal.path %}");
    expect(stored).toContain('title=t"{% $unprovided.name %}"');
    expect(stored).toContain("{% else /%}");
    expect(extractTopikAssetOccurrences(stored)).toMatchObject([
      { slot: "figure.src", reference: `asset:${asset?.name}`, kind: "asset" },
    ]);
    expect(analyzeTopikContent(stored).links.map((link) => link.href)).toEqual(["#install"]);
    expect(await readFile(join(dir, "install.md"), "utf8")).toBe(source);
  });

  test("keeps source byte-for-byte when there are no static references to rewrite", async () => {
    const source = [
      "# Example",
      "",
      '{% accordion title=t"Version {% $package.version %}" %}',
      "{% template code %}",
      "```text",
      "{% $package.name %}",
      "![This is code](missing.png)",
      "```",
      "{% /template code %}",
      "{% /accordion %}",
      "",
    ].join("\n");
    await writeFile(join(dir, "example.md"), source);

    const result = await compileGuides({ dir });
    const guide = result.resources.find((resource): resource is Guide => resource.type === "Guide");

    expect(result.diagnostics).toEqual([]);
    expect(result.resources).toHaveLength(1);
    expect(result.payloads).toEqual([]);
    expect(guide?.spec.content.value).toBe(source);
  });

  test.each(['t"An example image"', 't"{% $unprovided.name %}"'])(
    "accepts explicit accessible authoring intent in figure alt %s without evaluating it",
    async (alt) => {
      await writeFile(join(dir, "hero.png"), png);
      await writeFile(
        join(dir, "figure.md"),
        `# Figure\n\n{% figure src="hero.png" alt=${alt} caption="Image caption" /%}\n`,
      );

      const result = await compileGuides({
        dir,
        assets: {
          generateName: createProjectAssetNameGenerator({
            projectRoot: dir,
            projectNamespace: "figure-template-alt",
          }),
        },
      });
      const guide = result.resources.find(
        (resource): resource is Guide => resource.type === "Guide",
      );

      expect(result.diagnostics).toEqual([]);
      expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
      expect(guide?.spec.content.value).toContain(`alt=${alt}`);
    },
  );

  test.each(['t""', 't"   "', '""', '"   "'])(
    "keeps the existing meaningful figure-alt requirement for %s even when a caption exists",
    async (alt) => {
      await writeFile(join(dir, "hero.png"), png);
      await writeFile(
        join(dir, "figure.md"),
        `# Figure\n\n{% figure src="hero.png" alt=${alt} caption="Image caption" /%}\n`,
      );

      await expect(
        compileGuides({
          dir,
          assets: {
            generateName: createProjectAssetNameGenerator({
              projectRoot: dir,
              projectNamespace: "empty-figure-alt",
            }),
          },
        }),
      ).rejects.toMatchObject({
        diagnostics: [
          expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_ACCESSIBILITY_INVALID" }),
        ],
      });
    },
  );
});
