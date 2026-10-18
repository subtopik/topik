import type { BigIntStats } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { readPortableAssetFile } from "./files";

const injection = vi.hoisted(() => ({
  target: "",
  field: "" as keyof BigIntStats | "",
  applied: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith(`/${injection.target}`)) {
        const stat = handle.stat.bind(handle);
        let reads = 0;
        // Alter only the second snapshot: filesystem admission and real reads still run.
        handle.stat = (async (...statArgs: Parameters<typeof stat>) => {
          const snapshot = await stat(...statArgs);
          if (++reads === 2 && injection.field) {
            const field = injection.field;
            const value = snapshot[field as keyof typeof snapshot];
            if (typeof value !== "bigint") throw new Error("Expected bigint stat evidence");
            Object.defineProperty(snapshot, field, { value: value + 1n });
            injection.applied = true;
          }
          return snapshot;
        }) as typeof handle.stat;
      }
      return handle;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  injection.target = "";
  injection.field = "";
  injection.applied = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const targets = [
  { target: "hero.png", message: "File identity changed while hashing" },
  { target: ".git", message: "Git boundary identity changed while it was inspected" },
  { target: ".gitattributes", message: "Git attribute evidence changed while it was evaluated" },
];
const fields = ["dev", "ino", "mode", "nlink", "size", "ctimeNs", "mtimeNs"] as const;

async function fixture(target: string, field: keyof BigIntStats | "") {
  const root = await mkdtemp(join(tmpdir(), "topik-file-stability-"));
  roots.push(root);
  await writeFile(join(root, "hero.png"), "stable bytes");
  // A directory without HEAD supplies anchored boundary evidence without a Git worktree.
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".gitattributes"), "# No filtering\n");
  injection.target = target;
  injection.field = field;
  return readPortableAssetFile({ root, path: "hero.png" });
}

test
  .skipIf(process.platform !== "linux")
  .each(
    targets.flatMap(({ target, message }) => fields.map((field) => ({ target, message, field }))),
  )("rejects changed $field evidence for $target", async ({ target, message, field }) => {
  const result = await fixture(target, field);
  expect(injection.applied).toBe(true);
  expect(result).toMatchObject({
    ok: false,
    diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED", message }],
  });
});

test.skipIf(process.platform !== "linux").each(targets)(
  "accepts unchanged evidence and access-time changes for $target",
  async ({ target }) => {
    expect(await fixture(target, "")).toMatchObject({ ok: true });
    expect(await fixture(target, "atimeNs")).toMatchObject({ ok: true });
    expect(injection.applied).toBe(true);
  },
);
