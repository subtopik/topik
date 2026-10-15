import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { assertRegularFileWithinRoot, readRegularFileWithinRoot } from "./files";
import { compileWiki } from "./wiki";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
let root: string;
let outside: string;
const linuxTest = test.skipIf(process.platform !== "linux");
const platforms: NodeJS.Platform[] =
  process.platform === "linux" ? ["linux", "darwin", "win32"] : ["darwin", "win32"];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "topik-contained-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "topik-outside-")));
  await mkdir(join(root, "pages"));
  await writeFile(join(root, "pages/intro.md"), "# Contained\n");
  await writeFile(join(outside, "intro.md"), "# Outside\n");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(lstat).mockReset();
  vi.mocked(open).mockReset();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(open).mockImplementation(actual.open);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function swapPages() {
  await rename(join(root, "pages"), join(root, "original-pages"));
  await symlink(outside, join(root, "pages"), "dir");
}

test("reads and asserts contained regular files at the root and in nested directories", async () => {
  await writeFile(join(root, "config.yaml"), "id: docs\n");
  expect(await readRegularFileWithinRoot(join(root, "config.yaml"), root, "utf8")).toBe(
    "id: docs\n",
  );
  expect(await readRegularFileWithinRoot(join(root, "pages/intro.md"), root)).toEqual(
    Buffer.from("# Contained\n"),
  );
  await expect(
    assertRegularFileWithinRoot(join(root, "pages/intro.md"), root),
  ).resolves.toBeUndefined();
  await expect(readRegularFileWithinRoot(join(root, "pages"), root)).rejects.toMatchObject({
    id: "file-not-regular",
  });
  await expect(readRegularFileWithinRoot(join(outside, "intro.md"), root)).rejects.toMatchObject({
    id: "file-outside-compilation-root",
  });
});

linuxTest(
  "compilation rejects an intermediate directory swapped after the successful file lstat",
  async () => {
    await writeFile(
      join(root, "wiki.yaml"),
      "id: docs\ntitle: Docs\nnavigation:\n  - pages/intro\n",
    );
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let swapped = false;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const result = await actual.lstat(...args);
      if (args[0] === join(root, "pages/intro.md") && !swapped) {
        swapped = true;
        await swapPages();
      }
      return result;
    });
    await expect(compileWiki({ dir: root })).rejects.toMatchObject({ id: "file-not-regular" });
    expect(swapped).toBe(true);
    expect(await readFile(join(outside, "intro.md"), "utf8")).toBe("# Outside\n");
  },
);

linuxTest(
  "a directory swapped after opening stays anchored to the original directory",
  async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let swapped = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (String(args[0]).endsWith("/pages") && !swapped) {
        swapped = true;
        await swapPages();
      }
      return handle;
    });
    expect(await readRegularFileWithinRoot(join(root, "pages/intro.md"), root, "utf8")).toBe(
      "# Contained\n",
    );
    expect(swapped).toBe(true);
  },
);

linuxTest("rejects a source root ancestor swapped after lstat", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await mkdir(join(outside, "pages"));
  await writeFile(join(outside, "pages/intro.md"), "# Outside\n");
  const originalRoot = `${root}-original`;
  vi.mocked(lstat).mockImplementation(async (...args) => {
    const result = await actual.lstat(...args);
    await rename(root, originalRoot);
    await symlink(outside, root, "dir");
    return result;
  });
  try {
    await expect(
      readRegularFileWithinRoot(join(root, "pages/intro.md"), root),
    ).rejects.toMatchObject({ id: "file-not-regular" });
  } finally {
    await rm(originalRoot, { recursive: true, force: true });
  }
});

linuxTest.each([false, true])("closes all handles after a read (swap: %s)", async (swap) => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  vi.mocked(open).mockImplementation(async (...args) => {
    if (swap && String(args[0]).endsWith("/pages")) await swapPages();
    const handle = await actual.open(...args);
    handles.push(handle);
    return handle;
  });
  const reading = readRegularFileWithinRoot(join(root, "pages/intro.md"), root);
  if (swap) await expect(reading).rejects.toMatchObject({ id: "file-not-regular" });
  else await expect(reading).resolves.toEqual(Buffer.from("# Contained\n"));
  expect(handles.length).toBeGreaterThan(0);
  for (const handle of handles)
    await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
});

test("a final-component symlink swapped at open is rejected", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(async (...args) => {
    if (basename(String(args[0])) === "intro.md") {
      await rm(join(root, "pages/intro.md"));
      await symlink(join(outside, "intro.md"), join(root, "pages/intro.md"));
    }
    return actual.open(...args);
  });
  await expect(readRegularFileWithinRoot(join(root, "pages/intro.md"), root)).rejects.toMatchObject(
    { id: "file-not-regular" },
  );
});

test.each(platforms)("selects the contained reader for %s", async (platform) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  expect(await readRegularFileWithinRoot(join(root, "pages/intro.md"), root, "utf8")).toBe(
    "# Contained\n",
  );
  const openedPaths = vi.mocked(open).mock.calls.map(([path]) => String(path));
  if (platform === "linux") {
    expect(openedPaths.some((path) => path.startsWith("/proc/self/fd/"))).toBe(true);
  } else {
    expect(openedPaths).toEqual([join(root, "pages/intro.md")]);
  }
});

test.each(platforms)("rejects traversal and static symlink escapes on %s", async (platform) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  await symlink(outside, join(root, "escape"), "junction");
  await symlink(join(root, "pages"), join(outside, "back"), "junction");
  await symlink(join(outside, "intro.md"), join(root, "outside.md"));
  await symlink(join(root, "pages/intro.md"), join(root, "alias.md"));

  for (const path of [
    join(root, relative(root, join(outside, "intro.md"))),
    join(outside, "back/intro.md"),
    join(root, "escape/intro.md"),
    join(root, "outside.md"),
  ]) {
    await expect(readRegularFileWithinRoot(path, root)).rejects.toMatchObject({
      id: "file-outside-compilation-root",
    });
  }
  await expect(readRegularFileWithinRoot(join(root, "alias.md"), root)).rejects.toMatchObject({
    id: "file-not-regular",
  });
  await expect(readRegularFileWithinRoot(join(root, "pages"), root)).rejects.toMatchObject({
    id: "file-not-regular",
  });
  expect(open).not.toHaveBeenCalled();
});

test.each(["darwin", "win32"] as const)(
  "allows ancestor aliases but rejects a symlinked source root on %s",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const alias = join(outside, "alias");
    await symlink(root, alias, "junction");
    expect(
      await readRegularFileWithinRoot(join(alias, "pages/intro.md"), join(alias, "pages"), "utf8"),
    ).toBe("# Contained\n");
    await expect(
      readRegularFileWithinRoot(join(alias, "pages/intro.md"), alias),
    ).rejects.toMatchObject({
      id: "file-not-regular",
    });
  },
);

test.each(["darwin", "win32"] as const)(
  "rejects replacement before open and closes the portable handle on %s",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    vi.mocked(open).mockImplementation(async (...args) => {
      await rename(join(root, "pages/intro.md"), join(root, "pages/original.md"));
      await symlink(join(outside, "intro.md"), join(root, "pages/intro.md"));
      // Model an open without O_NOFOLLOW: the handle identity must still be checked.
      opened = await actual.open(args[0], constants.O_RDONLY);
      return opened;
    });
    await expect(
      readRegularFileWithinRoot(join(root, "pages/intro.md"), root),
    ).rejects.toMatchObject({
      id: "file-not-regular",
      location: "pages/intro.md",
    });
    expect(opened).toBeDefined();
    await expect(opened!.stat()).rejects.toMatchObject({ code: "EBADF" });
  },
);

test.each(["darwin", "win32"] as const)(
  "reads the checked portable handle after path replacement on %s",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    vi.mocked(open).mockImplementation(async (...args) => {
      opened = await actual.open(...args);
      await rename(join(root, "pages/intro.md"), join(root, "pages/original.md"));
      await writeFile(join(root, "pages/intro.md"), "# Replacement\n");
      return opened;
    });
    expect(await readRegularFileWithinRoot(join(root, "pages/intro.md"), root, "utf8")).toBe(
      "# Contained\n",
    );
    expect(opened).toBeDefined();
    await expect(opened!.stat()).rejects.toMatchObject({ code: "EBADF" });
  },
);

linuxTest("fails closed when procfs descriptor traversal is unavailable", async () => {
  const close = vi.fn(async () => {});
  vi.mocked(open).mockImplementationOnce(
    async () =>
      ({
        fd: 2147483647,
        stat: async () => ({ isDirectory: () => true }),
        close: async () => {
          await close();
        },
      }) as Awaited<ReturnType<typeof open>>,
  );
  await expect(readRegularFileWithinRoot(join(root, "pages/intro.md"), root)).rejects.toMatchObject(
    { id: "file-safe-read-unsupported" },
  );
  expect(constants.O_NOFOLLOW).toBeTypeOf("number");
  expect(open).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledOnce();
});

linuxTest(
  "compiles beneath an ancestor with search permission but no read permission",
  async () => {
    const sourceRoot = join(root, "pages");
    await writeFile(join(sourceRoot, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation: [intro]\n");
    await chmod(root, 0o111);
    try {
      const result = await compileWiki({ dir: sourceRoot });
      expect(result.resources).toContainEqual(
        expect.objectContaining({
          type: "WikiPage",
          spec: expect.objectContaining({ title: "Contained" }),
        }),
      );
    } finally {
      await chmod(root, 0o700);
    }
  },
);
