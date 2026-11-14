import { beforeEach, expect, test, vi } from "vite-plus/test";
import { withSourceScratch } from "./project";
import { encodeSource } from "./syntax";

// Model Windows path joining on any host. These are modeled paths and filesystem
// calls, not evidence about a native Windows filesystem.
const fs = vi.hoisted(() => ({
  mkdtemp: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  ...fs,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  tmpdir: () => "C:\\Temp",
}));
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    dirname: (path: string) => actual.win32.dirname(path),
    join: (...paths: string[]) => actual.win32.join(...paths),
    sep: actual.win32.sep,
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  fs.mkdtemp.mockImplementation(async (prefix: string) => `${prefix}abc`);
});

test("scratch trees create each nested parent with platform path semantics", async () => {
  const seen = await withSourceScratch(
    [
      { path: "docs/pages/intro.md", mode: "100644", bytes: encodeSource("# Intro\n") },
      { path: "README.md", mode: "100755", bytes: encodeSource("Readme\n") },
    ],
    async (dir) => dir,
  );
  const dir = "C:\\Temp\\topik-source-project-abc";
  expect(seen).toBe(dir);
  expect(fs.mkdir.mock.calls).toEqual([
    [dir, { recursive: true }],
    [`${dir}\\docs\\pages`, { recursive: true }],
  ]);
  expect(fs.writeFile.mock.calls.map(([path]) => path)).toEqual([
    `${dir}\\README.md`,
    `${dir}\\docs\\pages\\intro.md`,
  ]);
  expect(fs.rm).toHaveBeenCalledWith(dir, { recursive: true, force: true });
});
