import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { publishMigration, type MigrationEdit } from "./migration";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
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
  vi.mocked(rename).mockReset();
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

test("refuses an occupied destination before publishing links", async () => {
  await writeFile(edits[1].destination, "Existing\n");
  await expect(publishMigration(edits)).rejects.toThrow("Destination already exists");
  for (const edit of edits) expect(await readFile(edit.path, "utf8")).toBe(edit.source);
  expect(await readFile(edits[1].destination, "utf8")).toBe("Existing\n");
});

test("retains recovery files and reports their location if rollback fails", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (basename(String(from)) === "original") throw new Error("restore failed");
    if (basename(String(from)) === "candidate" && String(to) === edits[1].destination)
      throw new Error("publish failed");
    return actual.rename(from, to);
  });
  await expect(publishMigration(edits)).rejects.toThrow(
    /rollback incomplete.*Recovery files retained:/,
  );
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
