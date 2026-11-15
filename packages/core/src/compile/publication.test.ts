import { lstatSync, renameSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  OutputPublicationError,
  publishOutputDirectory,
  removeOutputDirectory,
  type OutputPublicationOptions,
} from "./publication";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

/** Owned when every file is named `owned-*`. */
const options: OutputPublicationOptions = {
  generationPrefix: ".test-generation-",
  priorPrefix: ".test-prior-",
  directories: ["data"],
  fileMode: 0o644,
  isOwned: (entries) =>
    entries.every((entry) => entry.kind === "directory" || entry.path.startsWith("data/owned-")),
};

describe.each(["linux", "darwin"] as const)("output publication (%s)", (platform) => {
  // Anchored publication needs a real Linux kernel; portable publication runs anywhere.
  const it = test.runIf(platform !== "linux" || process.platform === "linux");
  let root: string;
  let target: string;

  beforeEach(async () => {
    if (platform !== process.platform) {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    }
    root = await mkdtemp(join(tmpdir(), "topik-output-publication-"));
    target = join(root, "out");
    await publishOutputDirectory(target, [{ path: "data/owned-1", bytes: "first" }], options);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync);
    vi.mocked(lstatSync).mockReset().mockImplementation(actual.lstatSync);
    await rm(root, { recursive: true, force: true });
  });

  it("replaces an owned output and refuses a foreign one", async () => {
    await publishOutputDirectory(target, [{ path: "data/owned-2", bytes: "second" }], options);
    expect(await readdir(join(target, "data"))).toEqual(["owned-2"]);

    await writeFile(join(target, "data", "author.txt"), "keep");
    await expect(publishOutputDirectory(target, [], options)).rejects.toMatchObject({
      reason: "not-owned",
    });
    await expect(removeOutputDirectory(target, options)).rejects.toBeInstanceOf(
      OutputPublicationError,
    );
    expect(await readFile(join(target, "data", "author.txt"), "utf8")).toBe("keep");
  });

  it("retains the previous output after a failed publication unless asked to remove it", async () => {
    const failure = Object.assign(new Error("Injected"), { code: "EIO" });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from).includes(".test-generation-")) throw failure;
      actual.renameSync(from, to);
    });

    const error = await publishOutputDirectory(target, [], options).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "publication-failed", cause: failure });
    const priors = (await readdir(root)).filter((name) => name.startsWith(".test-prior-"));
    expect(priors).toHaveLength(1);
    expect(await readdir(join(root, priors[0], "data"))).toEqual(["owned-1"]);

    actual.renameSync(join(root, priors[0]), target);
    await expect(
      publishOutputDirectory(target, [], { ...options, removePriorOnFailure: true }),
    ).rejects.toBe(failure);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses to move aside a directory swapped in after ownership was proven", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const moved = join(root, "moved");
    let swapped = false;
    vi.mocked(lstatSync).mockImplementation(((path: string, ...rest: never[]) => {
      // Swap the target just before the backup name is checked, after staging completed.
      if (!swapped && String(path).includes(".test-prior-")) {
        swapped = true;
        actual.renameSync(target, moved);
        actual.mkdirSync(target);
        actual.writeFileSync(join(target, "foreign.txt"), "keep");
      }
      return actual.lstatSync(path, ...rest);
    }) as typeof lstatSync);

    await expect(
      publishOutputDirectory(target, [{ path: "data/owned-2", bytes: "second" }], options),
    ).rejects.toThrow(/changed after its ownership was proven/u);
    expect(swapped).toBe(true);
    expect(await readdir(target)).toEqual(["foreign.txt"]);
    expect(await readdir(join(moved, "data"))).toEqual(["owned-1"]);
    expect((await readdir(root)).sort()).toEqual(["moved", "out"]);
  });

  it("never follows a directory replaced by a link while removing the previous output", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "owned-1"), "outside file");
    let prior = "";
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from) === target || String(from).endsWith(`/${"out"}`)) prior = String(to);
      actual.renameSync(from, to);
      if (String(from).includes(".test-generation-")) {
        // After publication, before the previous output is removed.
        actual.renameSync(join(prior, "data"), join(root, "displaced"));
        actual.symlinkSync(outside, join(prior, "data"), "dir");
      }
    });

    await expect(
      publishOutputDirectory(target, [{ path: "data/owned-2", bytes: "second" }], options),
    ).rejects.toThrow();
    expect(prior).not.toBe("");
    expect(await readFile(join(outside, "owned-1"), "utf8")).toBe("outside file");
    expect(await readdir(join(target, "data"))).toEqual(["owned-2"]);
  });

  it("removes an owned or empty output and ignores a missing one", async () => {
    await removeOutputDirectory(target, options);
    expect(await readdir(root)).toEqual([]);
    await removeOutputDirectory(target, options);
    await removeOutputDirectory(join(root, "missing", "out"), options);
    await expect(readdir(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(target);
    await removeOutputDirectory(target, options);
    expect(await readdir(root)).toEqual([]);
  });
});
