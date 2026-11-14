import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { publishMigration, type MigrationEdit } from "./migration";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

let dir: string;
let edits: MigrationEdit[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "topik-migration-"));
  edits = [
    {
      path: join(dir, "start.md"),
      destination: join(dir, "start.md"),
      source: "[Next](./next.mdx)\n",
      content: "[Next](./next.md)\n",
    },
    {
      path: join(dir, "next.mdx"),
      destination: join(dir, "next.md"),
      source: "# Next\n",
      content: "# Next\n",
    },
  ];
  for (const edit of edits) await writeFile(edit.path, edit.source);
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(link).mockReset().mockImplementation(actual.link);
  vi.mocked(unlink).mockReset().mockImplementation(actual.unlink);
  vi.mocked(rename).mockReset();
  vi.mocked(rm).mockReset();
  vi.mocked(writeFile).mockReset();
  await rm(dir, { recursive: true, force: true });
});

async function expectOriginalFiles() {
  expect((await readdir(dir)).sort()).toEqual(["next.mdx", "start.md"]);
  for (const edit of edits) expect(await readFile(edit.path, "utf8")).toBe(edit.source);
}

test("staging failure leaves all original files intact", async () => {
  vi.mocked(writeFile).mockRejectedValueOnce(new Error("disk full"));
  await expect(publishMigration(edits)).rejects.toThrow("disk full");
  await expectOriginalFiles();
});

test("failed later publication rolls back previously updated links and filenames", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (basename(String(from)) === "candidate" && String(to) === edits[1].destination)
      throw new Error("rename failed");
    return actual.rename(from, to);
  });
  await expect(publishMigration(edits)).rejects.toThrow("rename failed");
  await expectOriginalFiles();
});

test.each(["staging", "publication"])(
  "cleanup failure after %s failure preserves the original error and continues cleanup",
  async (phase) => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const originalError = new Error(`${phase} failed`);
    if (phase === "staging") {
      vi.mocked(writeFile)
        .mockImplementationOnce(actual.writeFile)
        .mockRejectedValueOnce(originalError);
    } else {
      vi.mocked(rename).mockImplementation(async (from, to) => {
        if (basename(String(from)) === "candidate" && String(to) === edits[1].destination)
          throw originalError;
        return actual.rename(from, to);
      });
    }
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup denied"));

    await expect(publishMigration(edits)).rejects.toBe(originalError);
    expect(rm).toHaveBeenCalledTimes(2);
    const retainedDirectory = basename(String(vi.mocked(rm).mock.calls[0][0]));
    expect((await readdir(dir)).sort()).toEqual([retainedDirectory, "next.mdx", "start.md"].sort());
    for (const edit of edits) expect(await readFile(edit.path, "utf8")).toBe(edit.source);
  },
);

test("refuses an occupied destination before publishing links", async () => {
  await writeFile(edits[1].destination, "Existing\n");
  await expect(publishMigration(edits)).rejects.toThrow("Destination already exists");
  for (const edit of edits) expect(await readFile(edit.path, "utf8")).toBe(edit.source);
  expect(await readFile(edits[1].destination, "utf8")).toBe("Existing\n");
});

test("retains recovery files and reports their location if rollback fails", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const originalError = new Error("publish failed");
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (basename(String(from)) === "original") throw new Error("restore failed");
    if (basename(String(from)) === "candidate" && String(to) === edits[1].destination)
      throw originalError;
    return actual.rename(from, to);
  });
  const failure = await publishMigration(edits).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe(originalError);
  expect((failure as Error).message).toMatch(/rollback incomplete.*Recovery files retained:/);
  expect(rm).not.toHaveBeenCalled();
  const recoveries = (await readdir(dir)).filter((name) => name.startsWith(".topik-codemod-"));
  expect(recoveries).toHaveLength(2);
  const originals = await Promise.all(
    recoveries.map((name) => readFile(join(dir, name, "original"), "utf8")),
  );
  expect(originals.sort()).toEqual(edits.map((edit) => edit.source).sort());
});

test("publishes complete edits, cleans temporary files, and preserves file permissions", async () => {
  if (process.platform !== "win32") await chmod(edits[1].path, 0o640);
  expect(await publishMigration(edits)).toEqual([]);
  expect((await readdir(dir)).sort()).toEqual(["next.md", "start.md"]);
  for (const edit of edits) expect(await readFile(edit.destination, "utf8")).toBe(edit.content);
  if (process.platform !== "win32")
    expect((await stat(edits[1].destination)).mode & 0o777).toBe(0o640);
});

test("keeps every source in the visible tree after each publication step", async () => {
  // An interruption can happen between any two filesystem operations. Later runs
  // skip hidden staging directories, so each source must stay visible throughout.
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const snapshots: string[][] = [];
  const visible = async () => {
    const files = (await actual.readdir(dir)).filter((name) => !name.startsWith("."));
    return Promise.all(files.map((name) => actual.readFile(join(dir, name), "utf8")));
  };
  vi.mocked(rename).mockImplementation(async (from, to) => {
    await actual.rename(from, to);
    snapshots.push(await visible());
  });
  vi.mocked(unlink).mockImplementation(async (path) => {
    await actual.unlink(path);
    snapshots.push(await visible());
  });
  expect(await publishMigration(edits)).toEqual([]);
  expect(snapshots.length).toBeGreaterThan(0);
  for (const contents of snapshots)
    for (const edit of edits)
      expect(contents.includes(edit.source) || contents.includes(edit.content)).toBe(true);
});

test("falls back to copied backups when hard links are unavailable", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(link).mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (basename(String(from)) === "candidate" && String(to) === edits[1].destination)
      throw new Error("rename failed");
    return actual.rename(from, to);
  });
  await expect(publishMigration(edits)).rejects.toThrow("rename failed");
  await expectOriginalFiles();
  vi.mocked(rename).mockImplementation(actual.rename);
  expect(await publishMigration(edits)).toEqual([]);
  expect((await readdir(dir)).sort()).toEqual(["next.md", "start.md"]);
});
