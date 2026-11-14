import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { runMintlify } from "./runner";
import { analyzeTopikContent } from "@topik/content";

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

  test("captures per-file errors without aborting the run", async () => {
    await writeFile(join(dir, "good.mdx"), "<Note>ok</Note>\n");
    await writeFile(join(dir, "blocked.mdx"), "<Note>x</Note>\n");
    await writeFile(join(dir, "blocked.md"), "# pre-existing\n");

    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
    expect(summary.files).toHaveLength(3); // good.mdx, blocked.mdx, blocked.md
    const good = summary.files.find((f) => f.relativePath === "good.mdx");
    expect(good?.error).toBeUndefined();
    expect(good?.changed).toBe(true);
    const blocked = summary.files.find((f) => f.relativePath === "blocked.mdx");
    expect(blocked?.error).toMatch(/already exists/);
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

  test("renames metadata-only files without changing their bytes", async () => {
    const source = Buffer.from(
      '\uFEFF---\r\ntitle: "<Note>Metadata</Note>"\r\n---\r\n\r\n# Body\r\n',
    );
    await writeFile(join(dir, "metadata.mdx"), source);

    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });

    expect(summary).toMatchObject({ filesChanged: 1, warnings: 0 });
    expect(summary.files[0]?.error).toBeUndefined();
    expect(await readFile(join(dir, "metadata.md"))).toEqual(source);
    expect(await readdir(dir)).not.toContain("metadata.mdx");
  });

  test("preserves non-UTF-8 bytes and keeps extensions when those sources cannot be inspected", async () => {
    const bytes = Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]);
    await writeFile(join(dir, "legacy.mdx"), bytes);
    await writeFile(join(dir, "valid.mdx"), "# Valid\n");
    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
    expect(summary.filesChanged).toBe(0);
    expect(
      summary.files.find((file) => file.relativePath === "legacy.mdx")?.warnings[0]?.message,
    ).toMatch(/not valid UTF-8/);
    expect(await readFile(join(dir, "legacy.mdx"))).toEqual(bytes);
    expect(await readdir(dir)).toEqual(["legacy.mdx", "valid.mdx"]);
  });

  test("keeps an unsupported MDX file and its extension unchanged", async () => {
    const source = '<Note>Helpful.</Note>\n<Icon icon="star" />\n';
    await writeFile(join(dir, "unsupported.mdx"), source);

    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });

    expect(summary.filesChanged).toBe(0);
    expect(summary.warnings).toBeGreaterThan(0);
    expect(summary.files[0]).toMatchObject({ changed: false, relativePath: "unsupported.mdx" });
    expect(await readFile(join(dir, "unsupported.mdx"), "utf-8")).toBe(source);
    expect(await readdir(dir)).not.toContain("unsupported.md");
  });

  test("does not rename an untouched file containing unknown JSX", async () => {
    const source = '<CustomThing title="x" />\n';
    await writeFile(join(dir, "custom.mdx"), source);

    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });

    expect(summary.filesChanged).toBe(0);
    expect(summary.warnings).toBeGreaterThan(0);
    expect(await readdir(dir)).toContain("custom.mdx");
    expect(await readFile(join(dir, "custom.mdx"), "utf-8")).toBe(source);
  });

  test("repairs navigation in Markdown and converted cards, preserving query and fragment spelling", async () => {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "next page.mdx"), "# Next\n");
    await writeFile(
      join(dir, "nested", "start.mdx"),
      [
        "[Next][target]",
        "",
        "[target]: ./next%20page.md%78?mode=a%20b&mode=c#next%20heading",
        "",
        '<Card title="Next" href="../nested/next%20page.mdx?x=1#next">Read more.</Card>',
        "",
        "{% if $show %}",
        "[Root](/nested/next%20page.mdx#next)",
        "{% else /%}",
        "[Other](./next%20page.mdx)",
        "{% /if %}",
        "",
        "[External](https://example.com/nested/next%20page.mdx)",
        "[Missing](missing.mdx)",
        "[Anchor](#next.mdx)",
        "[Trailing](./next%20page.mdx/%2F?mode=full#next)",
        "",
        "`[Example](./next%20page.mdx)`",
        "",
        "```md",
        "[Example](./next%20page.mdx)",
        "```",
        "",
      ].join("\n"),
    );
    await writeFile(join(dir, "existing.md"), "[Next](./nested/next%20page.mdx?keep=%26#next)\n");

    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });

    expect(summary).toMatchObject({ filesChanged: 3, warnings: 0 });
    expect(summary.files.every((file) => !file.error)).toBe(true);
    const content = await readFile(join(dir, "nested", "start.md"), "utf8");
    expect(analyzeTopikContent(content).links.map((link) => link.href)).toEqual([
      "./next%20page.md?mode=a%20b&mode=c#next%20heading",
      "../nested/next%20page.md?x=1#next",
      "/nested/next%20page.md#next",
      "./next%20page.md",
      "https://example.com/nested/next%20page.mdx",
      "missing.mdx",
      "#next.mdx",
      "./next%20page.md/%2F?mode=full#next",
    ]);
    expect(content).toContain("`[Example](./next%20page.mdx)`");
    expect(content).toContain("```md\n[Example](./next%20page.mdx)\n```");
    expect(await readFile(join(dir, "existing.md"), "utf8")).toContain(
      "./nested/next%20page.md?keep=%26#next",
    );
  });

  test.each([false, true])(
    "rewrites only successful rename targets (dry run: %s)",
    async (dryRun) => {
      const source = "[Blocked](./blocked.mdx?x=1#head)\n[Good](./good.mdx?x=2#head)\n";
      await writeFile(join(dir, "start.md"), source);
      await writeFile(join(dir, "blocked.mdx"), "# Head\n");
      await writeFile(join(dir, "blocked.md"), "# Existing\n");
      await writeFile(join(dir, "good.mdx"), "# Head\n");
      const summary = await runMintlify({ dir, dryRun, keepExtension: false });
      expect(summary.filesChanged).toBe(2);
      expect(summary.files.find((file) => file.relativePath === "blocked.mdx")?.error).toMatch(
        /already exists/,
      );
      const result = await readFile(join(dir, "start.md"), "utf8");
      expect(result).toContain("./blocked.mdx?x=1#head");
      expect(result).toContain(dryRun ? "./good.mdx?x=2#head" : "./good.md?x=2#head");
      if (dryRun) expect(result).toBe(source);
    },
  );

  test("keeps extensions across the run if an unsupported file might link to renamed pages", async () => {
    const unsupported = "<CustomThing />\n\n[Good](./good.mdx)\n";
    await writeFile(join(dir, "unsupported.mdx"), unsupported);
    await writeFile(join(dir, "good.mdx"), "<Note>Good.</Note>\n");
    await writeFile(join(dir, "other.mdx"), "# Other\n");
    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
    expect(summary.filesChanged).toBe(1);
    // One run-level notice, rather than a warning on every rename candidate.
    expect(summary.notices).toEqual([
      expect.stringMatching(/^Kept .mdx extensions on 2 file\(s\)/),
    ]);
    expect(summary.files.find((file) => file.relativePath === "good.mdx")?.warnings).toEqual([]);
    expect(summary.files.find((file) => file.relativePath === "other.mdx")).toMatchObject({
      changed: false,
      warnings: [],
    });
    expect(summary.warnings).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(["good.mdx", "other.mdx", "unsupported.mdx"]);
    expect(await readFile(join(dir, "unsupported.mdx"), "utf8")).toBe(unsupported);
    expect(await readFile(join(dir, "good.mdx"), "utf8")).toContain("{% callout");
  });

  test("keeps extensions if a shared image/link definition cannot be safely rewritten", async () => {
    const source = "[Page][shared]\n\n![Image][shared]\n\n[shared]: next.mdx\n";
    await writeFile(join(dir, "start.mdx"), source);
    await writeFile(join(dir, "next.mdx"), "# Next\n");
    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
    expect(summary.filesChanged).toBe(0);
    expect(summary.warnings).toBe(0);
    expect(summary.notices).toEqual([
      expect.stringContaining("navigation in start.mdx could not be safely rewritten"),
    ]);
    expect(await readFile(join(dir, "start.mdx"), "utf8")).toBe(source);
    expect(await readdir(dir)).toEqual(["next.mdx", "start.mdx"]);
  });

  test("keep-extension leaves navigation destinations untouched", async () => {
    const source = "[Next](./next.mdx?x=1#head)\n";
    await writeFile(join(dir, "start.mdx"), source);
    await writeFile(join(dir, "next.mdx"), "# Head\n");
    const summary = await runMintlify({ dir, dryRun: false, keepExtension: true });
    expect(summary).toMatchObject({ filesChanged: 0, warnings: 0 });
    expect(await readFile(join(dir, "start.mdx"), "utf8")).toBe(source);
  });

  test.each([
    ["ESM", "import { Thing } from '/snippets/thing.mdx'\n\n# Page\n"],
    ["an expression", "# Page\n\n{/* Mintlify comment */}\n"],
  ])("keeps .mdx files that contain MDX-only %s", async (_name, source) => {
    await writeFile(join(dir, "page.mdx"), source);
    await writeFile(join(dir, "plain.md"), "Not MDX: {braces} stay text.\n");
    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
    expect(summary.files.find((file) => file.relativePath === "page.mdx")).toMatchObject({
      changed: false,
      warnings: [{ message: expect.stringContaining("MDX") }],
    });
    expect(summary.files.find((file) => file.relativePath === "plain.md")?.warnings).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(["page.mdx", "plain.md"]);
    expect(await readFile(join(dir, "page.mdx"), "utf8")).toBe(source);
  });

  test("converts idiomatically indented bodies and reports content changes", async () => {
    await writeFile(
      join(dir, "steps.mdx"),
      '<Steps>\n  <Step title="A">\n    Some text here\n  </Step>\n</Steps>\n',
    );
    await writeFile(join(dir, "plain.mdx"), "# Plain\n");
    const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
    expect(summary.files.find((file) => file.relativePath === "steps.mdx")).toMatchObject({
      changed: true,
      contentChanged: true,
      newRelativePath: "steps.md",
    });
    expect(summary.files.find((file) => file.relativePath === "plain.mdx")).toMatchObject({
      changed: true,
      contentChanged: false,
      newRelativePath: "plain.md",
    });
    expect(await readFile(join(dir, "steps.md"), "utf8")).toBe(
      '{% steps %}\n{% step title="A" %}\nSome text here\n{% /step %}\n{% /steps %}\n',
    );
  });

  test("reports staging directories left by an interrupted run", async () => {
    await mkdir(join(dir, "guides", ".topik-codemod-abc123"), { recursive: true });
    await writeFile(join(dir, "guides", ".topik-codemod-abc123", "original"), "# Lost\n");
    await writeFile(join(dir, "guides", "page.mdx"), "# Page\n");
    const summary = await runMintlify({ dir, dryRun: true, keepExtension: false });
    expect(summary.notices).toEqual([
      expect.stringMatching(/^Found guides[/\\].topik-codemod-abc123 from an interrupted/),
    ]);
    expect(summary.files.map((file) => file.relativePath)).toEqual([join("guides", "page.mdx")]);
  });

  test.skipIf(process.platform === "win32")(
    "does not overwrite a dangling destination symlink",
    async () => {
      await writeFile(join(dir, "page.mdx"), "# Page\n");
      await symlink(join(dir, "missing.md"), join(dir, "page.md"));
      const summary = await runMintlify({ dir, dryRun: false, keepExtension: false });
      expect(summary.files[0]?.error).toMatch(/already exists/);
      expect(summary.filesChanged).toBe(0);
      expect(await readFile(join(dir, "page.mdx"), "utf8")).toBe("# Page\n");
    },
  );
});
