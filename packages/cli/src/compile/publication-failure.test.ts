import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { formatPublicCliError, PublicCliError } from "../errors";
import { compile } from "./index";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), unlinkSync: vi.fn(actual.unlinkSync) };
});
const handler = (
  compile as unknown as {
    handler: (options: {
      dir: string;
      format: "json";
      dryRun: boolean;
      validate: boolean;
      links: "error";
    }) => Promise<void>;
  }
).handler;
let dir: string;
let previous: Record<string, string>;
const options = () => ({
  dir,
  format: "json" as const,
  dryRun: false,
  validate: true,
  links: "error" as const,
});
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(root.length + 1)] = (await readFile(path)).toString("base64");
    }
  }
  return files;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "topik-publication-failure-"));
  await writeFile(
    join(dir, ".topik.yaml"),
    JSON.stringify({
      version: 1,
      namespace: "publication",
      sources: [{ kind: "collection", config: "collection.yaml" }],
    }),
  );
  await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
  await writeFile(join(dir, "intro.md"), "# Previous\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await handler(options());
  vi.mocked(renameSync).mockClear();
  previous = await snapshot(join(dir, ".topik"));
  await writeFile(join(dir, "intro.md"), "# Updated\n");
});
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync);
  vi.mocked(unlinkSync).mockReset().mockImplementation(actual.unlinkSync);
  await rm(dir, { recursive: true, force: true });
});

function eio() {
  return Object.assign(new Error("Injected publication failure"), { code: "EIO" });
}
async function backupNames(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith(".topik-compilation-prior-"));
}

async function expectStagingCleaned(): Promise<void> {
  expect(
    (await readdir(dir)).filter((name) => name.startsWith(".topik-compilation-generation-")),
  ).toEqual([]);
  expect(await readFile(join(dir, "intro.md"), "utf8")).toBe("# Updated\n");
}

async function expectPublicationFailure(cause: Error): Promise<unknown> {
  const error: unknown = await handler(options()).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(PublicCliError);
  expect(error).toMatchObject({ id: "compilation-publication-failed" });
  expect((error as Error).cause).toBe(cause);
  return error;
}

test("leaves output in place and preserves the error when moving it aside fails", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const failure = eio();
  vi.mocked(renameSync).mockImplementation(() => {
    throw failure;
  });
  await expect(handler(options())).rejects.toBe(failure);
  expect(await snapshot(join(dir, ".topik"))).toEqual(previous);
  expect(await backupNames()).toEqual([]);
  await expectStagingCleaned();
  vi.mocked(renameSync).mockImplementation(actual.renameSync);
  await handler(options());
  expect(await snapshot(join(dir, ".topik"))).not.toEqual(previous);
});

test("retains the backup for manual recovery after failed publication", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const failure = eio();
  failure.message += `: ${dir}/private-path`;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(from).includes(".topik-compilation-generation-")) throw failure;
    actual.renameSync(from, to);
  });
  const error = await expectPublicationFailure(failure);
  const message = formatPublicCliError(error);
  expect(message).toContain("manual recovery");
  expect(message).toContain("stop concurrent writers");
  expect(message).toContain(".topik-compilation-prior-*");
  expect(message).toContain("Verify the backup contents");
  expect(message).toContain("do not overwrite an existing output path");
  expect(message).not.toContain(dir);
  expect(message).not.toContain(failure.message);
  const backups = await backupNames();
  expect(backups).toHaveLength(1);
  expect(await snapshot(join(dir, backups[0]))).toEqual(previous);
  await expect(lstat(join(dir, ".topik"))).rejects.toMatchObject({ code: "ENOENT" });
  await expectStagingCleaned();
  expect(renameSync).toHaveBeenCalledTimes(2);

  // With writers stopped and both paths verified, an operator can restore the backup.
  actual.renameSync(join(dir, backups[0]), join(dir, ".topik"));
  expect(await snapshot(join(dir, ".topik"))).toEqual(previous);
  vi.mocked(renameSync).mockImplementation(actual.renameSync);
  await handler(options());
  expect(await snapshot(join(dir, ".topik"))).not.toEqual(previous);
  expect(await backupNames()).toEqual([]);
});

test("cleans a failed first publication without claiming a backup exists", async () => {
  await rm(join(dir, ".topik"), { recursive: true });
  const failure = eio();
  vi.mocked(renameSync).mockImplementation(() => {
    throw failure;
  });
  await expect(handler(options())).rejects.toBe(failure);
  expect(await backupNames()).toEqual([]);
  await expectStagingCleaned();
});

test.each(["source replacement", "empty target creation"])(
  "never enters the recovery rename race window: %s",
  async (scenario) => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const failure = eio();
    let recoveryAttempted = false;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from).includes(".topik-compilation-generation-")) throw failure;
      if (String(from).includes(".topik-compilation-prior-")) {
        // Substitute immediately before the former restore syscall, after its checks.
        recoveryAttempted = true;
        if (scenario === "source replacement") {
          actual.renameSync(from, `${String(from)}-saved`);
          mkdirSync(from);
          writeFileSync(join(String(from), "authored.md"), "keep authored content");
        } else {
          mkdirSync(to);
        }
      }
      actual.renameSync(from, to);
    });
    await expectPublicationFailure(failure);
    expect(recoveryAttempted).toBe(false);
    await expect(lstat(join(dir, ".topik"))).rejects.toMatchObject({ code: "ENOENT" });
    const backups = await backupNames();
    expect(backups).toHaveLength(1);
    expect(await snapshot(join(dir, backups[0]))).toEqual(previous);
    await expectStagingCleaned();
  },
);

test.each(["target appears", "prior replaced"])(
  "preserves concurrent filesystem changes after publication fails: %s",
  async (scenario) => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const failure = eio();
    let priorPath = "";
    let targetInode: bigint | undefined;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith("/.topik")) priorPath = String(to);
      if (String(from).includes(".topik-compilation-generation-")) {
        if (scenario === "target appears") {
          mkdirSync(to);
          writeFileSync(join(String(to), "authored.md"), "keep authored content");
          targetInode = lstatSync(to, { bigint: true }).ino;
        }
        if (scenario === "prior replaced") {
          actual.renameSync(priorPath, `${priorPath}-saved`);
          mkdirSync(priorPath);
          writeFileSync(join(priorPath, "authored.md"), "keep authored content");
        }
        throw failure;
      }
      actual.renameSync(from, to);
    });
    await expectPublicationFailure(failure);
    const saved = `${basename(priorPath)}${scenario === "prior replaced" ? "-saved" : ""}`;
    expect(await snapshot(join(dir, saved))).toEqual(previous);
    await expectStagingCleaned();
    if (scenario === "target appears") {
      expect(await readFile(join(dir, ".topik/authored.md"), "utf8")).toBe("keep authored content");
      expect((await lstat(join(dir, ".topik"), { bigint: true })).ino).toBe(targetInode);
    }
    if (scenario === "prior replaced")
      expect(await readFile(join(dir, saved.replace(/-saved$/, ""), "authored.md"), "utf8")).toBe(
        "keep authored content",
      );
    expect(renameSync).toHaveBeenCalledTimes(2);
  },
);

test("preserves the publication error and backup if staging cleanup also fails", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const failure = eio();
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(from).includes(".topik-compilation-generation-")) throw failure;
    actual.renameSync(from, to);
  });
  vi.mocked(unlinkSync).mockImplementation(() => {
    throw Object.assign(new Error("Injected cleanup failure"), { code: "EACCES" });
  });
  await expectPublicationFailure(failure);
  const backups = await backupNames();
  expect(backups).toHaveLength(1);
  expect(await snapshot(join(dir, backups[0]))).toEqual(previous);
  expect(await readFile(join(dir, "intro.md"), "utf8")).toBe("# Updated\n");
});

test("removes the previous generation only after successful publication", async () => {
  await handler(options());
  expect(await snapshot(join(dir, ".topik"))).not.toEqual(previous);
  expect(await backupNames()).toEqual([]);
  await expectStagingCleaned();
});
