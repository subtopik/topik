import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWiki } from "@topik/core";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { isMigrationInput, runMintlify } from "./runner";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "topik-codemod-features-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("diff", () => {
  test("attaches unified diffs and writes nothing", async () => {
    await writeFile(join(dir, "note.mdx"), "# Note\n\n<Note>Hi.</Note>\n");
    await writeFile(join(dir, "plain.mdx"), "# Plain\n");
    await writeFile(join(dir, "kept.md"), "# Kept\n");

    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false, diff: true });

    const byPath = Object.fromEntries(summary.files.map((file) => [file.relativePath, file]));
    expect(byPath["note.mdx"]?.diff).toBe(
      [
        "--- a/note.mdx",
        "+++ b/note.md",
        "@@ -1,3 +1,5 @@",
        " # Note",
        " ",
        "-<Note>Hi.</Note>",
        '+{% callout variant="info" %}',
        "+Hi.",
        "+{% /callout %}",
        "",
      ].join("\n"),
    );
    expect(byPath["plain.mdx"]?.diff).toBe("--- a/plain.mdx\n+++ b/plain.md\n");
    expect(byPath["kept.md"]?.diff).toBeUndefined();
    expect((await readdir(dir)).sort()).toEqual(["kept.md", "note.mdx", "plain.mdx"]);
    expect(await readFile(join(dir, "note.mdx"), "utf8")).toBe("# Note\n\n<Note>Hi.</Note>\n");
  });
});

describe("single-file input", () => {
  test("converts only the selected file and keeps its extension", async () => {
    await writeFile(join(dir, "page.mdx"), "<Tip>Only me.</Tip>\n");
    await writeFile(join(dir, "other.mdx"), "<Tip>Not me.</Tip>\n");

    const summary = await runMintlify({
      dir: join(dir, "page.mdx"),
      dryRun: false,
      keepExtension: false,
    });

    expect(summary.files.map((file) => file.relativePath)).toEqual(["page.mdx"]);
    expect(summary.filesChanged).toBe(1);
    expect(summary.notices).toEqual([
      "Kept .mdx extensions on 1 file(s) because pages outside the selected file were not inspected and may link to it; run the codemod on the directory to rename it",
    ]);
    expect(await readFile(join(dir, "page.mdx"), "utf8")).toContain('{% callout variant="tip" %}');
    expect(await readFile(join(dir, "other.mdx"), "utf8")).toBe("<Tip>Not me.</Tip>\n");
    expect(summary.navigation).toBeUndefined();
  });

  test("converts a single Markdown file in place", async () => {
    await writeFile(join(dir, "page.md"), "<Warning>Careful.</Warning>\n");
    const summary = await runMintlify({
      dir: join(dir, "page.md"),
      dryRun: false,
      keepExtension: false,
    });
    expect(summary).toMatchObject({ filesChanged: 1, notices: [] });
    expect(await readFile(join(dir, "page.md"), "utf8")).toContain('variant="warning"');
  });

  test("accepts directories and Markdown files only", async () => {
    await writeFile(join(dir, "page.MDX"), "# Page\n");
    await writeFile(join(dir, "notes.txt"), "text\n");
    await symlink(join(dir, "page.MDX"), join(dir, "link.mdx"));
    expect(await isMigrationInput(dir)).toBe(true);
    expect(await isMigrationInput(join(dir, "page.MDX"))).toBe(true);
    expect(await isMigrationInput(join(dir, "notes.txt"))).toBe(false);
    expect(await isMigrationInput(join(dir, "link.mdx"))).toBe(false);
    expect(await isMigrationInput(join(dir, "missing.mdx"))).toBe(false);
  });
});

describe("navigation", () => {
  async function writeMintlifySite() {
    await mkdir(join(dir, "guides"));
    await writeFile(
      join(dir, "index.mdx"),
      "# Home\n\n<Note>Start with [setup](/guides/setup).</Note>\n",
    );
    await writeFile(join(dir, "quickstart.mdx"), "# Quickstart\n\n<Tip>Fast.</Tip>\n");
    await writeFile(
      join(dir, "guides/setup.mdx"),
      '# Setup\n\n<Steps>\n<Step title="Install">\nRun it.\n</Step>\n</Steps>\n',
    );
    await writeFile(join(dir, "guides/deploy.md"), "# Deploy\n");
    await writeFile(
      join(dir, "docs.json"),
      JSON.stringify({
        $schema: "https://mintlify.com/docs.json",
        theme: "mint",
        name: "Acme Docs",
        navigation: {
          tabs: [
            {
              tab: "Guides",
              groups: [
                { group: "Get started", icon: "rocket", pages: ["index", "quickstart"] },
                { group: "Guides", pages: ["guides/setup", "guides/deploy", "guides/missing"] },
              ],
            },
            { tab: "Blog", href: "https://example.com/blog" },
          ],
        },
      }),
    );
  }

  test("writes a wiki.yaml that @topik/core compiles", async () => {
    await writeMintlifySite();

    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });

    expect(summary.navigation).toMatchObject({
      source: "docs.json",
      output: "wiki.yaml",
      changed: true,
    });
    expect(summary.navigation?.error).toBeUndefined();
    expect(summary.navigation?.warnings).toEqual([
      "navigation.tabs[0].groups[0].icon: icons are dropped",
      'navigation.tabs[0].groups[1].pages[2]: page "guides/missing" has no .md or .mdx file in the directory; not converted',
    ]);
    expect(summary.warnings).toBe(2);
    expect(await readFile(join(dir, "wiki.yaml"), "utf8")).toContain("id: acme-docs\n");

    const result = await compileWiki({ dir });
    expect(result.diagnostics).toEqual([]);
    const pages = result.resources
      .filter((resource) => resource.type === "WikiPage")
      .map((resource) => (resource.spec as { title: string }).title)
      .sort();
    expect(pages).toEqual(["Deploy", "Home", "Quickstart", "Setup"]);
  });

  test("dry runs and diffs plan wiki.yaml without writing it", async () => {
    await writeMintlifySite();
    const dry = await runMintlify({ dir, dryRun: true, keepExtension: false });
    expect(dry.navigation?.changed).toBe(true);
    const diff = await runMintlify({ dir, dryRun: false, keepExtension: false, diff: true });
    expect(diff.navigation?.diff).toMatch(
      /^--- \/dev\/null\n\+\+\+ b\/wiki\.yaml\n@@ -0,0 \+1,\d+ @@\n\+id: acme-docs\n/,
    );
    expect(await readdir(dir)).not.toContain("wiki.yaml");
  });

  test.each(["wiki.yaml", "wiki.yml", "wiki.json"])(
    "never replaces an existing %s",
    async (name) => {
      await writeMintlifySite();
      await writeFile(join(dir, name), "id: mine\n");

      const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });

      expect(summary.navigation).toBeUndefined();
      expect(summary.notices).toContain(
        `Kept the existing ${name}; navigation in docs.json was not converted`,
      );
      expect(await readFile(join(dir, name), "utf8")).toBe("id: mine\n");
    },
  );

  test("prefers docs.json over a legacy mint.json and reads mint.json alone", async () => {
    await writeFile(join(dir, "index.mdx"), "# Home\n");
    await writeFile(
      join(dir, "mint.json"),
      JSON.stringify({ name: "Legacy", navigation: [{ group: "Start", pages: ["index"] }] }),
    );
    const legacy = await runMintlify({ dir, dryRun: true, keepExtension: false });
    expect(legacy.navigation).toMatchObject({ source: "mint.json", changed: true, warnings: [] });

    await writeFile(join(dir, "docs.json"), JSON.stringify({ name: "Current", navigation: {} }));
    const current = await runMintlify({ dir, dryRun: true, keepExtension: false });
    expect(current.navigation?.source).toBe("docs.json");
    expect(current.notices).toContain("Read docs.json and ignored the legacy mint.json");
  });

  test("reports an unreadable configuration without writing", async () => {
    await writeFile(join(dir, "docs.json"), "{ not json");
    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
    expect(summary.navigation).toMatchObject({
      changed: false,
      error: "Unable to read docs.json as JSON",
    });
    expect(await readdir(dir)).not.toContain("wiki.yaml");
  });
});
