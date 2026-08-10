import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  TOPIK_PATH_V1_DESCRIPTOR,
  computeTopikPathCollisionKey,
  readPortableAssetFile,
  validatePortableAssetFile,
  validateTopikPath,
  validateTopikPathSet,
  type PortableAssetFileDescriptor,
} from "./index";
import {
  readPortableAssetFileWithReadHookForTest,
  readPortableAssetFileWithTraversalHookForTest,
} from "./files";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function file(overrides: Partial<PortableAssetFileDescriptor> = {}): PortableAssetFileDescriptor {
  return {
    path: "assets/hero.png",
    type: "regular",
    mode: "100644",
    bytes: PNG_BYTES,
    linkCount: 1,
    ...overrides,
  };
}

describe("topik-path-v1 boundaries", () => {
  test("pins Unicode collision semantics while preserving accepted NFC spelling", () => {
    expect(TOPIK_PATH_V1_DESCRIPTOR.unicodeVersion).toBe("17.0.0");
    expect(validateTopikPath("Café/Photo.png")).toMatchObject({
      ok: true,
      value: { path: "Café/Photo.png" },
    });
    expect(validateTopikPath("Cafe\u0301/Photo.png")).toMatchObject({
      ok: false,
      diagnostics: [{ reason: "not_nfc" }],
    });
    expect(computeTopikPathCollisionKey("Straße.png")).toMatchObject({
      ok: true,
      value: "strasse.png",
    });
    expect(validateTopikPathSet(["Straße.png", "STRASSE.png"])).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_PATH_COLLISION" }],
    });
    expect(validateTopikPathSet(["a", "a/b"])).toMatchObject({ ok: false });
  });

  test.each([
    ["absolute", "/a.png", "absolute"],
    ["traversal", "../a.png", "dot_segment"],
    ["encoded alias", "a%2Fb.png", "forbidden_character"],
    ["slash alias", "a∕b.png", "separator_alias"],
    ["Git control", ".Git/config", "reserved_name"],
    ["DOS name", "CON.txt", "reserved_name"],
    ["trailing dot", "file.", "forbidden_character"],
    ["control", "a\u0000b", "forbidden_character"],
    ["bidi", "a\u202eb", "forbidden_character"],
  ])("rejects %s paths", (_name, path, reason) => {
    expect(validateTopikPath(path)).toMatchObject({ ok: false, diagnostics: [{ reason }] });
  });

  test("enforces component, count, and bound-path maxima without caller weakening", () => {
    expect(validateTopikPath("a".repeat(255))).toMatchObject({ ok: true });
    expect(validateTopikPath("a".repeat(256))).toMatchObject({ ok: false });
    expect(validateTopikPath(Array.from({ length: 64 }, () => "a").join("/"))).toMatchObject({
      ok: true,
    });
    expect(validateTopikPath(Array.from({ length: 65 }, () => "a").join("/"))).toMatchObject({
      ok: false,
    });
    expect(validateTopikPath("asset.bin", { bindingRoot: "b".repeat(760) })).toMatchObject({
      ok: false,
    });
    expect(
      validateTopikPath("a".repeat(256), {
        capabilities: { maxComponentUtf8Bytes: 10_000 },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("portable file descriptor boundaries", () => {
  test.each([
    ["symlink", { type: "symlink" }],
    ["hard link", { type: "hardlink" }],
    ["gitlink", { type: "gitlink", mode: "160000" }],
    ["device", { type: "device" }],
    ["executable", { mode: "100755" }],
    ["alternate stream", { hasAlternateDataStream: true }],
    ["LFS filter", { contentFilter: "lfs" }],
    ["custom filter", { contentFilter: "custom" }],
    ["working-tree encoding", { workingTreeEncoding: "utf-16" }],
  ])("rejects %s descriptors", (_name, overrides) => {
    expect(validatePortableAssetFile(file(overrides as never))).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }],
    });
  });

  test("rejects LFS pointer bytes and enforces source-specific modes", () => {
    const pointer = new TextEncoder().encode(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1\n`,
    );
    expect(validatePortableAssetFile(file({ bytes: pointer }))).toMatchObject({ ok: false });
    expect(validatePortableAssetFile(file({ source: "git", mode: "100644" }))).toMatchObject({
      ok: true,
    });
    expect(validatePortableAssetFile(file({ source: "archive", mode: "0644" }))).toMatchObject({
      ok: true,
    });
    expect(validatePortableAssetFile(file({ source: "git", mode: "0644" }))).toMatchObject({
      ok: false,
    });
  });
});

describe("descriptor-anchored filesystem reads", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("accepts a stable file and rejects link, executable, and root-link inputs", async () => {
    const parent = await mkdtemp(join(tmpdir(), "topik-file-matrix-"));
    roots.push(parent);
    const root = join(parent, "root");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "hero.png"), PNG_BYTES, { mode: 0o644 });
    expect(await readPortableAssetFile({ root, path: "assets/hero.png" })).toMatchObject({
      ok: true,
    });

    await symlink("assets", join(root, "linked"));
    expect(await readPortableAssetFile({ root, path: "linked/hero.png" })).toMatchObject({
      ok: false,
    });
    await link(join(root, "assets", "hero.png"), join(root, "assets", "copy.png"));
    expect(await readPortableAssetFile({ root, path: "assets/copy.png" })).toMatchObject({
      ok: false,
    });
    await writeFile(join(root, "executable"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await readPortableAssetFile({ root, path: "executable" })).toMatchObject({ ok: false });
    await symlink(root, join(parent, "root-link"), "dir");
    expect(
      await readPortableAssetFile({ root: join(parent, "root-link"), path: "assets/hero.png" }),
    ).toMatchObject({ ok: false });
  });

  test.each([
    ["LFS", "*.png filter=lfs\n"],
    ["custom filter", "hero.png filter=custom\n"],
    ["working-tree encoding", "*.png working-tree-encoding=UTF-16\n"],
    ["explicitly unset filter", "hero.png -filter\n"],
    ["unproven character class", "[h]ero.png filter=lfs\n"],
    ["unproven recursive pattern", "**/*.png filter=lfs\n"],
  ])("rejects effective or unproven %s attributes", async (_name, attributes) => {
    const root = await mkdtemp(join(tmpdir(), "topik-attributes-"));
    roots.push(root);
    await writeFile(join(root, ".gitattributes"), attributes);
    await writeFile(join(root, "hero.png"), PNG_BYTES);
    expect(await readPortableAssetFile({ root, path: "hero.png" })).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }],
    });
  });

  test("accepts only explicit nested resets to unspecified", async () => {
    const root = await mkdtemp(join(tmpdir(), "topik-attribute-reset-"));
    roots.push(root);
    await mkdir(join(root, "assets"));
    await writeFile(
      join(root, ".gitattributes"),
      "*.png filter=custom working-tree-encoding=UTF-16\n",
    );
    await writeFile(
      join(root, "assets", ".gitattributes"),
      "hero.png !filter !working-tree-encoding\n",
    );
    await writeFile(join(root, "assets", "hero.png"), PNG_BYTES);
    expect(await readPortableAssetFile({ root, path: "assets/hero.png" })).toMatchObject({
      ok: true,
    });
  });

  test("evaluates effective ancestor, info, and configured global Git attributes", async () => {
    const repository = await mkdtemp(join(tmpdir(), "topik-effective-attributes-"));
    roots.push(repository);
    await createMinimalWorktree(repository);
    const root = join(repository, "nested");
    await mkdir(root);
    await writeFile(join(root, "file.bin"), "bytes");

    await writeFile(join(repository, ".gitattributes"), "*.bin filter=lfs\n");
    expect(await readPortableAssetFile({ root, path: "file.bin" })).toMatchObject({ ok: false });

    await writeFile(join(root, ".gitattributes"), "file.bin !filter\n");
    expect(await readPortableAssetFile({ root, path: "file.bin" })).toMatchObject({ ok: true });

    await mkdir(join(repository, ".git", "info"));
    await writeFile(join(repository, ".git", "info", "attributes"), "*.bin filter=info\n");
    expect(await readPortableAssetFile({ root, path: "file.bin" })).toMatchObject({ ok: false });

    await writeFile(join(repository, ".git", "info", "attributes"), "");
    await writeFile(join(repository, ".gitattributes"), "");
    const globalAttributes = join(repository, "global-attributes");
    const globalConfig = join(repository, "global-config");
    await writeFile(globalAttributes, "*.bin working-tree-encoding=UTF-16\n");
    await writeFile(globalConfig, `[core]\n\tattributesFile = ${globalAttributes}\n`);
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      expect(await readPortableAssetFile({ root, path: "file.bin" })).toMatchObject({ ok: false });
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    }
  });

  test("stays anchored when an opened directory is replaced by a symlink", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "topik-race-root-"));
    const outside = await mkdtemp(join(tmpdir(), "topik-race-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "hero.png"), PNG_BYTES);
    await writeFile(join(outside, "hero.png"), "outside");
    let swapped = false;

    const result = await readPortableAssetFileWithTraversalHookForTest(
      { root, path: "assets/hero.png" },
      async (components) => {
        if (swapped || components.join("/") !== "assets") return;
        swapped = true;
        await rename(join(root, "assets"), join(root, "assets-original"));
        await symlink(outside, join(root, "assets"));
      },
    );

    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.bytes).toEqual(PNG_BYTES);
  });

  test("rejects a hardlink created and removed after the file bytes are read", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "topik-hardlink-race-"));
    roots.push(root);
    const source = join(root, "hero.png");
    const hardlink = join(root, "transient-hardlink.png");
    await writeFile(source, PNG_BYTES);

    const result = await readPortableAssetFileWithReadHookForTest(
      { root, path: "hero.png" },
      async () => {
        await link(source, hardlink);
        await rm(hardlink);
      },
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }],
    });
    await expect(lstat(hardlink)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects byte mutation even when the original mtime is restored", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "topik-byte-race-"));
    roots.push(root);
    const source = join(root, "hero.png");
    await writeFile(source, PNG_BYTES);
    const original = await lstat(source);
    const changed = Buffer.from(PNG_BYTES);
    changed[changed.byteLength - 1] ^= 0xff;

    const result = await readPortableAssetFileWithReadHookForTest(
      { root, path: "hero.png" },
      async () => {
        await writeFile(source, changed);
        await utimes(source, original.atime, original.mtime);
      },
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }],
    });
  });
});

async function createMinimalWorktree(root: string): Promise<void> {
  await mkdir(join(root, ".git", "objects"), { recursive: true });
  await mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(
    join(root, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
  );
}
