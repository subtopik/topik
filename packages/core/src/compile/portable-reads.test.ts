import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, chown, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createPortableReadSession,
  findTrustedGitExecutable,
  readPortableAssetFileInSession,
} from "../assets/files";
import { compile } from "./index";
import { compileGuides } from "./guide";
import { compileWiki } from "./wiki";
import { PublicCompileError } from "./public-errors";
import { CompileError } from "./shared";

// Count every Git process the compiler starts; the real command still runs.
const spawned = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: ((...args: Parameters<typeof actual.execFile>) => {
      const commandArgs = Array.isArray(args[1]) ? (args[1] as string[]) : [];
      spawned.commands.push(commandArgs[2] ?? String(args[0]));
      return (actual.execFile as (...values: unknown[]) => unknown)(...args);
    }) as typeof actual.execFile,
  };
});

const GIT = "/usr/bin/git";
const linuxTest = test.skipIf(process.platform !== "linux");
const gitTest = test.skipIf(process.platform !== "linux" || !existsSync(GIT));
const rootGitTest = test.skipIf(
  process.platform !== "linux" || !existsSync(GIT) || process.getuid?.() !== 0,
);
const MANIFEST =
  "version: 1\nnamespace: example/portable\nsources:\n  - kind: collection\n    config: collection.yaml\n";

const roots: string[] = [];
const savedEnvironment = { ...process.env };
afterEach(async () => {
  spawned.commands.length = 0;
  for (const name of Object.keys(process.env))
    if (!(name in savedEnvironment)) delete process.env[name];
  Object.assign(process.env, savedEnvironment);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function collectionProject(dir: string, pages: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".topik.yaml"), MANIFEST);
  await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
  await writeFile(join(dir, "manual.pdf"), "%PDF-1.4\n%%EOF\n");
  for (let index = 0; index < pages; index++) {
    await writeFile(
      join(dir, `page-${index}.md`),
      `# Page ${index}\n\n[Manual](./manual.pdf) and [again](./manual.pdf)\n`,
    );
  }
}

function git(dir: string, ...args: string[]): void {
  execFileSync(GIT, ["-C", dir, ...args], { stdio: "ignore" });
}

describe("Git repository evidence", () => {
  gitTest("is computed once per compilation, not once per link", async () => {
    const counts: number[] = [];
    for (const pages of [1, 30]) {
      const dir = await temporaryDirectory("topik-git-cost-");
      await collectionProject(dir, pages);
      git(dir, "init", "-q");
      spawned.commands.length = 0;
      const result = await compile({ dir });
      expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
      counts.push(spawned.commands.length);
    }
    // Repository discovery and the index are read once; each distinct file read is checked
    // with one `check-attr` (manifest, collection config and the linked PDF).
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThanOrEqual(5);
  });

  gitTest("ignores an inherited GIT_DIR meant for another repository", async () => {
    const repository = await temporaryDirectory("topik-git-dir-");
    git(repository, "init", "-q");
    const dir = join(repository, "docs");
    await collectionProject(dir, 1);
    process.env.GIT_DIR = ".git";
    process.env.GIT_WORK_TREE = "/";

    await expect(compile({ dir })).resolves.toMatchObject({ diagnostics: [] });
  });

  gitTest("compiles beside an unrelated `git lfs track` pattern", async () => {
    for (const repository of [true, false]) {
      const dir = await temporaryDirectory("topik-lfs-pattern-");
      await collectionProject(dir, 1);
      if (repository) git(dir, "init", "-q");
      await writeFile(
        join(dir, ".gitattributes"),
        "design/**/*.psd filter=lfs diff=lfs merge=lfs -text\n",
      );

      await expect(compile({ dir })).resolves.toMatchObject({ diagnostics: [] });
    }
  });

  gitTest("still refuses a file the recursive pattern filters", async () => {
    for (const repository of [true, false]) {
      const dir = await temporaryDirectory("topik-lfs-match-");
      await collectionProject(dir, 1);
      if (repository) git(dir, "init", "-q");
      await writeFile(join(dir, ".gitattributes"), "**/*.yaml filter=lfs\n");

      const error = await compile({ dir }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        id: "config-read-failed",
        location: ".topik.yaml",
        reason: "git-filtered",
      });
    }
  });

  gitTest("treats an ancestor `.git` that Git rejects as no repository", async () => {
    const parent = await temporaryDirectory("topik-broken-git-");
    await mkdir(join(parent, ".git"));
    await writeFile(join(parent, ".git", "HEAD"), "ref: refs/heads/main\n");
    const dir = join(parent, "project");
    await collectionProject(dir, 1);

    await expect(compile({ dir })).resolves.toMatchObject({ diagnostics: [] });
  });

  rootGitTest("explains a worktree that Git refuses for its owner", async () => {
    const dir = await temporaryDirectory("topik-dubious-");
    await collectionProject(dir, 1);
    git(dir, "init", "-q");
    await chown(dir, 54321, 54321);
    await chown(join(dir, ".git"), 54321, 54321);

    const error = await compile({ dir }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PublicCompileError);
    expect(error).toMatchObject({
      id: "config-read-failed",
      location: ".topik.yaml",
      reason: "git-repository-untrusted",
    });
    expect((error as Error).message).toContain("safe.directory");
    expect((error as Error).message).not.toContain(dir);
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
  });

  gitTest("re-derives cached evidence when a symlinked ancestor is retargeted", async () => {
    const standalone = await temporaryDirectory("topik-retarget-standalone-");
    const repository = await temporaryDirectory("topik-retarget-repository-");
    const aliases = await temporaryDirectory("topik-retarget-alias-");
    for (const base of [standalone, repository]) {
      await mkdir(join(base, "docs"));
      await writeFile(join(base, "docs", "hero.png"), "bytes\n");
    }
    git(repository, "init", "-q");
    await writeFile(join(repository, ".gitattributes"), "*.png filter=lfs\n");
    const alias = join(aliases, "current");
    await symlink(standalone, alias, "dir");
    const session = createPortableReadSession();
    const options = { root: join(alias, "docs"), path: "hero.png" };
    expect(await readPortableAssetFileInSession(session, options)).toMatchObject({ ok: true });

    await rm(alias);
    await symlink(repository, alias, "dir");
    expect(await readPortableAssetFileInSession(session, options)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }],
    });
  });

  linuxTest("finds Git only in trusted, non-writable locations", async () => {
    const dir = await temporaryDirectory("topik-git-locations-");
    const writable = join(dir, "writable-git");
    const plain = join(dir, "plain-git");
    const trusted = join(dir, "trusted-git");
    await writeFile(writable, "#!/bin/sh\n");
    await chmod(writable, 0o777);
    await writeFile(plain, "data\n");
    await chmod(plain, 0o644);
    await writeFile(trusted, "#!/bin/sh\n");
    await chmod(trusted, 0o755);

    expect(await findTrustedGitExecutable([join(dir, "missing"), writable, plain])).toBe(undefined);
    expect(await findTrustedGitExecutable([writable, plain, trusted])).toBe(trusted);
  });
});

describe("portable read diagnostics", () => {
  linuxTest.each([
    ["executable", async (path: string) => chmod(path, 0o755), "chmod a-x"],
    [
      "symbolic-link",
      async (path: string) => {
        await writeFile(`${path}.target`, MANIFEST);
        await rm(path);
        await symlink(`${path}.target`, path);
      },
      "symbolic link",
    ],
  ] as const)("names the %s cause of an unreadable manifest", async (reason, change, text) => {
    const dir = await temporaryDirectory("topik-read-reason-");
    await collectionProject(dir, 1);
    await change(join(dir, ".topik.yaml"));

    const error = await compile({ dir }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ id: "config-read-failed", location: ".topik.yaml", reason });
    expect((error as Error).message).toMatch(/^Configuration file could not be read safely\. /u);
    expect((error as Error).message).toContain(text);
    expect((error as Error).message).not.toContain(dir);
  });

  linuxTest("accepts a source directory below a symlinked ancestor", async () => {
    const real = await temporaryDirectory("topik-real-ancestor-");
    const aliases = await temporaryDirectory("topik-alias-ancestor-");
    await collectionProject(join(real, "project"), 1);
    await symlink(real, join(aliases, "home"), "dir");

    await expect(compile({ dir: join(aliases, "home", "project") })).resolves.toMatchObject({
      diagnostics: [],
    });
    // A symlinked source directory itself stays refused, with a specific reason.
    await symlink(join(real, "project"), join(aliases, "project"), "dir");
    await expect(compile({ dir: join(aliases, "project") })).rejects.toMatchObject({
      id: "config-read-failed",
      reason: "symbolic-link",
    });
  });

  test("reports a dangling guide symlink as a located diagnostic", async () => {
    const dir = await temporaryDirectory("topik-dangling-guide-");
    await mkdir(join(dir, "guides"));
    await writeFile(join(dir, "guides", "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "guides", "a.md"), "# A\n");
    await symlink("missing.md", join(dir, "guides", "b.md"));

    const error = await compileGuides({ dir: join(dir, "guides") }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CompileError);
    expect((error as CompileError).diagnostics).toEqual([
      expect.objectContaining({ id: "guide-not-regular-file", file: "b.md" }),
    ]);
    expect(JSON.stringify((error as CompileError).diagnostics)).not.toContain(dir);
  });

  test("resolves extensionless page links where anchored reads are unavailable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const dir = await temporaryDirectory("topik-darwin-links-");
    await writeFile(
      join(dir, "wiki.yaml"),
      "id: docs\ntitle: Docs\nnavigation:\n  - a\n  - other\n",
    );
    await writeFile(join(dir, "a.md"), "# A\n\n[Other](./other)\n");
    await writeFile(join(dir, "other.md"), "# Other\n");

    const result = await compileWiki({ dir });
    expect(result.references).toEqual([
      expect.objectContaining({ href: "./other", status: "verified" }),
    ]);
  });

  test.each(["darwin", "win32"] as const)(
    "compiles a project with assets on %s and honours fileSafety",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const dir = await temporaryDirectory("topik-portable-project-");
      await collectionProject(dir, 2);
      await writeFile(join(dir, "page-0.md"), "# Page 0\n\n[Manual](./manual.pdf)\n");

      const result = await compile({ dir });
      expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
      await expect(compile({ dir, fileSafety: "anchored" })).rejects.toMatchObject({
        id: "config-read-failed",
        location: ".topik.yaml",
        reason: "platform-unsupported",
      });
    },
  );
});
