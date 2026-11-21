import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

/** Name of the file whose write fails after it was created exclusively. */
const failing = vi.hoisted(() => ({
  name: undefined as string | undefined,
  // Report another spelling of the created path, as Windows does for short and long names.
  respell: false,
}));

function diskFull(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
}

// Simulate a write that fails after the exclusive create succeeded.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fails = (path: unknown) =>
    failing.name !== undefined && String(path).endsWith(failing.name);
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const first = await actual.mkdir(...args);
      return failing.respell && first !== undefined ? `${first}-respelled` : first;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (fails(args[0])) {
        handle.writeFile = () => Promise.reject(diskFull());
      }
      return handle;
    },
  };
});

const { initProject } = await import("./index");

describe("init rollback", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-init-rollback-"));
  });

  afterEach(async () => {
    failing.name = undefined;
    failing.respell = false;
    await rm(dir, { recursive: true, force: true });
  });

  test.each([".topik.yaml", "wiki.yaml", "index.md", "AGENTS.md"])(
    "removes every file it created when writing %s fails",
    async (name) => {
      failing.name = name;

      await expect(initProject(dir)).rejects.toMatchObject({ id: "init-write-failed" });
      expect(await readdir(dir)).toEqual([]);
    },
  );

  test.each([false, true])(
    "removes only the directories it created when writing fails (respelled: %s)",
    async (respell) => {
      failing.respell = respell;
      failing.name = "index.md";
      await expect(initProject(join(dir, "new", "project"))).rejects.toMatchObject({
        id: "init-write-failed",
      });
      expect(await readdir(dir)).toEqual([]);
    },
  );
});
