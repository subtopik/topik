import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  DEFAULT_FILE_SAFETY,
  classifyPortableNavigationPath,
  findTrustedGitExecutable,
  portableReadFailureReason,
  readPortableAssetFile,
  readPortableAssetFileWithReadHookForTest,
  readPortableAssetFileWithTraversalHookForTest,
  trustedGitLocations,
  usesPortableFileReads,
  type FileSafety,
} from "./files";

// Swap a file between the reader's inspection and its open, without changing what is read.
const openSwap = vi.hoisted(() => ({ target: "", replacement: "" }));
// Report resolved paths decomposed, as HFS+ (and APFS for NFD-created names) does.
const realpathForm = vi.hoisted(() => ({ decompose: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: (async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = String(await actual.realpath(...args));
      return realpathForm.decompose ? resolved.normalize("NFD") : resolved;
    }) as typeof actual.realpath,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (openSwap.target !== "" && String(args[0]) === openSwap.target) {
        await actual.rename(openSwap.replacement, openSwap.target);
        openSwap.target = "";
      }
      return actual.open(...args);
    }) as typeof actual.open,
  };
});

/**
 * The portable reader runs natively on macOS and Windows (see the compiler-portability
 * workflow). On Linux both platforms are simulated over the host filesystem.
 */
const PLATFORMS =
  process.platform === "linux" ? (["darwin", "win32"] as const) : [process.platform];
const roots: string[] = [];

afterEach(async () => {
  openSwap.target = "";
  realpathForm.decompose = false;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  // Canonical spelling, so native macOS /var and Windows short names do not matter.
  const root = await realpath(await mkdtemp(join(tmpdir(), "topik-portable-read-")));
  roots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "hero.png"), "bytes\n", { mode: 0o644 });
  return root;
}

/** Symlinks need privileges on some Windows hosts; such cases are skipped there only. */
async function trySymlink(target: string, path: string, type?: "dir" | "file"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    throw error;
  }
}

function reasonOf(result: Awaited<ReturnType<typeof readPortableAssetFile>>) {
  return result.ok ? undefined : portableReadFailureReason(result.diagnostics);
}

describe.each(PLATFORMS)("portable reads on %s", (platform) => {
  beforeEach(() => {
    if (process.platform !== platform)
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  });

  test("is the default and reads a plain file", async () => {
    expect(DEFAULT_FILE_SAFETY).toBe("portable");
    expect(usesPortableFileReads()).toBe(true);
    const root = await fixture();
    const result = await readPortableAssetFile({ root, path: "assets/hero.png" });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(Buffer.from(result.value.bytes ?? []).toString()).toBe("bytes\n");
  });

  test("fails with platform-unsupported when anchored reads are required", async () => {
    const root = await fixture();
    const result = await readPortableAssetFile({
      root,
      path: "assets/hero.png",
      fileSafety: "anchored" satisfies FileSafety,
    });
    expect(reasonOf(result)).toBe("platform-unsupported");
    expect(usesPortableFileReads("anchored")).toBe(false);
  });

  test("reports a missing file as missing and refuses lexical escapes", async () => {
    const root = await fixture();
    expect(await readPortableAssetFile({ root, path: "assets/none.png" })).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_FILE_MISSING" }],
    });
    expect(await readPortableAssetFile({ root, path: "../outside.png" })).toMatchObject({
      ok: false,
    });
  });

  test("refuses symlinks at the root, in a directory and as the file", async (context) => {
    const root = await fixture();
    const outside = await realpath(await mkdtemp(join(tmpdir(), "topik-portable-outside-")));
    roots.push(outside);
    await writeFile(join(outside, "hero.png"), "outside\n");
    if (!(await trySymlink(outside, join(root, "linked"), "dir"))) return context.skip();
    await trySymlink(join(outside, "hero.png"), join(root, "assets", "link.png"), "file");
    const rootLink = join(outside, "root-link");
    await trySymlink(root, rootLink, "dir");

    for (const [readRoot, path] of [
      [root, "linked/hero.png"],
      [root, "assets/link.png"],
      [rootLink, "assets/hero.png"],
    ] as const) {
      expect(reasonOf(await readPortableAssetFile({ root: readRoot, path }))).toBe("symbolic-link");
    }
  });

  test("accepts a symlinked ancestor above the root", async (context) => {
    const root = await fixture();
    const aliases = await realpath(await mkdtemp(join(tmpdir(), "topik-portable-alias-")));
    roots.push(aliases);
    if (!(await trySymlink(join(root, ".."), join(aliases, "parent"), "dir"))) {
      return context.skip();
    }
    const aliasedRoot = join(aliases, "parent", root.split(/[\\/]/u).at(-1) ?? "");
    expect(
      await readPortableAssetFile({ root: aliasedRoot, path: "assets/hero.png" }),
    ).toMatchObject({ ok: true });
  });

  test("refuses a file swapped between inspection and open", async () => {
    const root = await fixture();
    await writeFile(join(root, "assets", "other.png"), "other\n");
    openSwap.target = join(root, "assets", "hero.png");
    openSwap.replacement = join(root, "assets", "other.png");

    const result = await readPortableAssetFile({ root, path: "assets/hero.png" });
    expect(openSwap.target).toBe("");
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ message: "File identity changed between inspection and open" }],
    });
    expect(reasonOf(result)).toBe("changed-during-read");
  });

  test("refuses a path that names another file after the read", async (context) => {
    const root = await fixture();
    let replaced = true;
    const result = await readPortableAssetFileWithReadHookForTest(
      { root, path: "assets/hero.png" },
      async () => {
        await writeFile(join(root, "assets", "replacement.png"), "bytes\n");
        try {
          await rename(join(root, "assets", "replacement.png"), join(root, "assets", "hero.png"));
        } catch (error) {
          // Some Windows filesystems refuse to replace a file that is open.
          if (process.platform !== "win32") throw error;
          replaced = false;
        }
      },
    );
    if (!replaced) return context.skip();
    // Replacing the name also unlinks the read file, so its own identity changes too.
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toMatch(
      /^(?:File path no longer names the file that was read|File identity changed while hashing)$/u,
    );
    expect(reasonOf(result)).toBe("changed-during-read");
  });

  test("refuses a directory replaced after it was inspected", async () => {
    const root = await fixture();
    const result = await readPortableAssetFileWithTraversalHookForTest(
      { root, path: "assets/hero.png" },
      async (components) => {
        if (components.join("/") !== "assets") return;
        await rename(join(root, "assets"), join(root, "assets-original"));
        await mkdir(join(root, "assets"));
        await writeFile(join(root, "assets", "hero.png"), "swapped\n");
      },
    );
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ message: "A directory on the file path changed while the file was read" }],
    });
  });

  test("reports anchored refusal before absence", async () => {
    const root = await fixture();
    expect(
      reasonOf(await readPortableAssetFile({ root, path: "none.yaml", fileSafety: "anchored" })),
    ).toBe("platform-unsupported");
  });

  test("accepts an NFC-authored name that the volume resolves decomposed", async () => {
    const root = await fixture();
    await writeFile(join(root, "assets", "caf\u00e9.png"), "accent\n");
    realpathForm.decompose = true;
    expect(await readPortableAssetFile({ root, path: "assets/caf\u00e9.png" })).toMatchObject({
      ok: true,
    });
  });

  test("cannot be redirected through an entry differing only by normalization", async (context) => {
    const root = await fixture();
    const outside = await realpath(await mkdtemp(join(tmpdir(), "topik-portable-nfd-")));
    roots.push(outside);
    await writeFile(join(outside, "secret.png"), "outside\n");
    // Only normalization-sensitive filesystems (ext4, NTFS) keep both spellings apart.
    await writeFile(join(root, "assets", "cafe\u0301.png"), "decomposed\n");
    try {
      await writeFile(join(root, "assets", "caf\u00e9.png"), "composed\n", { flag: "wx" });
    } catch {
      return context.skip();
    }
    const read = async () => readPortableAssetFile({ root, path: "assets/caf\u00e9.png" });
    const composed = await read();
    expect(composed.ok && Buffer.from(composed.value.bytes ?? []).toString()).toBe("composed\n");

    // The composed name becomes a link while its decomposed twin stays a regular file.
    await rm(join(root, "assets", "caf\u00e9.png"));
    if (!(await trySymlink(join(outside, "secret.png"), join(root, "assets", "caf\u00e9.png")))) {
      return context.skip();
    }
    realpathForm.decompose = true;
    expect(reasonOf(await read())).toBe("symbolic-link");
    await rm(join(root, "assets", "caf\u00e9.png"));
    await trySymlink(join(root, "assets", "cafe\u0301.png"), join(root, "assets", "caf\u00e9.png"));
    expect(reasonOf(await read())).toBe("symbolic-link");
  });

  test("keeps the hard-link, size and Git attribute checks", async () => {
    const root = await fixture();
    await link(join(root, "assets", "hero.png"), join(root, "assets", "copy.png"));
    expect(reasonOf(await readPortableAssetFile({ root, path: "assets/copy.png" }))).toBe(
      "hard-linked",
    );
    await rm(join(root, "assets", "copy.png"));
    expect(
      reasonOf(await readPortableAssetFile({ root, path: "assets/hero.png", maxBytes: 2 })),
    ).toBe("too-large");
    await writeFile(join(root, ".gitattributes"), "*.png filter=lfs\n");
    expect(reasonOf(await readPortableAssetFile({ root, path: "assets/hero.png" }))).toBe(
      "git-filtered",
    );
    await writeFile(join(root, ".gitattributes"), "design/**/*.psd filter=lfs\n");
    expect(await readPortableAssetFile({ root, path: "assets/hero.png" })).toMatchObject({
      ok: true,
    });
  });

  test("refuses a nested Git worktree and asks Git inside a worktree", async () => {
    const root = await fixture();
    await mkdir(join(root, "assets", ".git"));
    expect(reasonOf(await readPortableAssetFile({ root, path: "assets/hero.png" }))).toBe(
      "git-submodule",
    );
    await rm(join(root, "assets", ".git"), { recursive: true });

    // A minimal worktree whose only filter is in .git/info/attributes, which only Git sees.
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await mkdir(join(root, ".git", "objects"));
    await mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    await writeFile(join(root, ".git", "info", "attributes"), "*.png filter=lfs\n");
    const reason = reasonOf(await readPortableAssetFile({ root, path: "assets/hero.png" }));
    // Simulated Windows on a Linux host finds no Git in Program Files and fails closed.
    expect(reason).toBe(
      (await findTrustedGitExecutable()) === undefined
        ? "git-evidence-unavailable"
        : "git-filtered",
    );
  });

  test(`${platform === "win32" ? "drops" : "keeps"} the executable-bit check`, async () => {
    const root = await fixture();
    await writeFile(join(root, "tool"), "#!/bin/sh\n");
    await chmod(join(root, "tool"), 0o755);
    const result = await readPortableAssetFile({ root, path: "tool" });
    if (platform === "win32") expect(result).toMatchObject({ ok: true });
    else expect(reasonOf(result)).toBe("executable");
  });

  test(`${platform === "win32" ? "drops" : "keeps"} the allocated-blocks check`, async () => {
    const root = await fixture();
    await writeFile(join(root, "sparse.bin"), "");
    await truncate(join(root, "sparse.bin"), 1024 * 1024);
    const sparse = await stat(join(root, "sparse.bin"));
    const result = await readPortableAssetFile({ root, path: "sparse.bin" });
    if (platform === "win32") expect(result).toMatchObject({ ok: true });
    else if (sparse.blocks * 512 < sparse.size) expect(reasonOf(result)).toBe("special-file");
    else expect(result).toMatchObject({ ok: true });
  });

  test(`trusts Git ${platform === "win32" ? "by fixed location" : "by owner and mode"}`, async () => {
    const root = await fixture();
    const plain = join(root, "git-plain");
    await writeFile(plain, "data\n");
    await chmod(plain, 0o644);
    expect(trustedGitLocations()[0]).toBe(
      platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git",
    );
    // Windows reports no execute bits or owner, so only the location can establish trust.
    expect(await findTrustedGitExecutable([plain])).toBe(platform === "win32" ? plain : undefined);
  });

  test("classifies directories without following links", async (context) => {
    const root = await fixture();
    expect(await classifyPortableNavigationPath({ root, path: "assets" })).toBe("directory");
    expect(await classifyPortableNavigationPath({ root, path: "assets/hero.png" })).toBe("other");
    expect(await classifyPortableNavigationPath({ root, path: "none" })).toBe("missing");
    expect(
      await classifyPortableNavigationPath({ root, path: "assets", fileSafety: "anchored" }),
    ).toBe("other");
    if (!(await trySymlink(join(root, "assets"), join(root, "alias"), "dir"))) {
      return context.skip();
    }
    expect(await classifyPortableNavigationPath({ root, path: "alias" })).toBe("other");
  });
});

test.skipIf(process.platform !== "linux")("Linux ignores the portable setting", async () => {
  const root = await fixture();
  // Linux keeps anchored reads: a root reached through a symlink is still refused, and the
  // traversal stays anchored when a directory is swapped for a link mid-read.
  const outside = await realpath(await mkdtemp(join(tmpdir(), "topik-portable-linux-")));
  roots.push(outside);
  await symlink(root, join(outside, "root-link"), "dir");
  const result = await readPortableAssetFile({
    root: join(outside, "root-link"),
    path: "assets/hero.png",
    fileSafety: "portable",
  });
  expect(reasonOf(result)).toBe("symbolic-link");
  expect(usesPortableFileReads("portable")).toBe(false);
});
