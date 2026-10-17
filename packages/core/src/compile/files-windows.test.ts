import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { readRegularFileWithinRoot } from "./files";

// Exercise Windows path semantics even on Unix test hosts. These are modeled paths
// and filesystem results, not evidence about a native Windows filesystem.
const fs = vi.hoisted(() => ({ lstat: vi.fn(), open: vi.fn(), realpath: vi.fn() }));
vi.mock("node:fs/promises", () => fs);
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    isAbsolute: (path: string) => actual.win32.isAbsolute(path),
    parse: (path: string) => actual.win32.parse(path),
    relative: (from: string, to: string) => actual.win32.relative(from, to),
    resolve: (...paths: string[]) => actual.win32.resolve(...paths),
    sep: actual.win32.sep,
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});
afterEach(() => vi.restoreAllMocks());

function filesystem(authoredRoot: string, canonicalRoot: string, canonicalFile: string) {
  const fileStat = { isFile: () => true, dev: 1n, ino: 2n };
  const handle = {
    stat: vi.fn(async () => fileStat),
    readFile: vi.fn(async () => Buffer.from("# Contained\n")),
    close: vi.fn(async () => {}),
  };
  fs.realpath.mockImplementation(async (path: string) =>
    path === authoredRoot ? canonicalRoot : canonicalFile,
  );
  fs.lstat.mockImplementation(async (path: string) =>
    path === authoredRoot ? { isDirectory: () => true } : fileStat,
  );
  fs.open.mockResolvedValue(handle);
  return handle;
}

test("rejects a static symlink to a distinct Windows root differing only by case", async () => {
  const root = "C:\\Source";
  filesystem(root, root, "C:\\source\\intro.md");
  await expect(readRegularFileWithinRoot("C:\\Source\\intro.md", root)).rejects.toMatchObject({
    id: "file-not-regular",
    location: "intro.md",
  });
  expect(fs.open).not.toHaveBeenCalled();
});

test("rejects a lexically outside Windows sibling differing only by case", async () => {
  const root = "C:\\Source";
  filesystem(root, root, "C:\\source\\intro.md");
  await expect(readRegularFileWithinRoot("C:\\source\\intro.md", root)).rejects.toMatchObject({
    id: "file-not-regular",
  });
  expect(fs.open).not.toHaveBeenCalled();
});

test.each([
  ["C:\\Source", "C:\\Source"],
  ["c:\\Source", "C:\\Source"],
  ["C:\\Alias\\Source", "D:\\Projects\\Source"],
])(
  "reads contained Windows files beneath %s resolved to %s",
  async (authoredRoot, canonicalRoot) => {
    const canonicalFile = `${canonicalRoot}\\intro.md`;
    const handle = filesystem(authoredRoot, canonicalRoot, canonicalFile);
    await expect(
      readRegularFileWithinRoot(`${authoredRoot}\\intro.md`, authoredRoot),
    ).resolves.toEqual(Buffer.from("# Contained\n"));
    expect(fs.open).toHaveBeenCalledExactlyOnceWith(canonicalFile, expect.any(Number));
    expect(handle.readFile).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  },
);
