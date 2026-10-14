import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { assertRegularFileWithinRoot, readRegularFileWithinRoot } from "./files";
import { compileWiki } from "./wiki";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
let root: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "topik-contained-"));
  outside = await mkdtemp(join(tmpdir(), "topik-outside-"));
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

test("compilation rejects an intermediate directory swapped after the successful file lstat", async () => {
  await writeFile(join(root, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - pages/intro\n");
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
});

test("a directory swapped after opening stays anchored to the original directory", async () => {
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
});

test("rejects a source root ancestor swapped after lstat", async () => {
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

test.each([false, true])("closes all handles after a read (swap: %s)", async (swap) => {
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
    if (String(args[0]).endsWith("/intro.md")) {
      await rm(join(root, "pages/intro.md"));
      await symlink(join(outside, "intro.md"), join(root, "pages/intro.md"));
    }
    return actual.open(...args);
  });
  await expect(readRegularFileWithinRoot(join(root, "pages/intro.md"), root)).rejects.toMatchObject(
    { id: "file-not-regular" },
  );
});

test.each(["darwin", "win32"])("fails closed on unsupported platform %s", async (platform) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
  await expect(readRegularFileWithinRoot(join(root, "pages/intro.md"), root)).rejects.toMatchObject(
    { id: "file-safe-read-unsupported" },
  );
  expect(open).not.toHaveBeenCalled();
});

test("fails closed when procfs descriptor traversal is unavailable", async () => {
  vi.mocked(open).mockImplementationOnce(
    async () =>
      ({
        fd: 2147483647,
        stat: async () => ({ isDirectory: () => true }),
        close: async () => {},
      }) as Awaited<ReturnType<typeof open>>,
  );
  await expect(readRegularFileWithinRoot(join(root, "pages/intro.md"), root)).rejects.toMatchObject(
    { id: "file-safe-read-unsupported" },
  );
  expect(constants.O_NOFOLLOW).toBeTypeOf("number");
});

test("compiles beneath an ancestor with search permission but no read permission", async () => {
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
});
