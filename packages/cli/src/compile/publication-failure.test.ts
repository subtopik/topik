import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { compile } from "./index";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
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
  previous = await snapshot(join(dir, ".topik"));
  await writeFile(join(dir, "intro.md"), "# Updated\n");
});
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync);
  await rm(dir, { recursive: true, force: true });
});

function eio() {
  return Object.assign(new Error("Injected publication failure"), { code: "EIO" });
}
test.each(["move previous", "publish staged"])(
  "preserves previous output when %s rename fails",
  async (boundary) => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const failure = eio();
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (
        boundary === "move previous"
          ? String(from).endsWith("/.topik")
          : String(from).includes(".topik-compilation-generation-")
      )
        throw failure;
      actual.renameSync(from, to);
    });
    await expect(handler(options())).rejects.toBe(failure);
    expect(await snapshot(join(dir, ".topik"))).toEqual(previous);
    expect((await readdir(dir)).filter((name) => name.startsWith(".topik-compilation-"))).toEqual(
      [],
    );
    expect(await readFile(join(dir, "intro.md"), "utf8")).toBe("# Updated\n");
    // A later successful compile can replace the restored generation normally.
    vi.mocked(renameSync).mockImplementation(actual.renameSync);
    await handler(options());
    expect(await snapshot(join(dir, ".topik"))).not.toEqual(previous);
  },
);

test.each(["rename fails", "target appears", "prior replaced"])(
  "retains previous bytes when recovery cannot proceed: %s",
  async (scenario) => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let priorPath = "";
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith("/.topik")) priorPath = String(to);
      if (String(from).includes(".topik-compilation-generation-")) {
        if (scenario === "target appears") {
          mkdirSync(to);
          writeFileSync(join(String(to), "authored.md"), "keep authored content");
        }
        if (scenario === "prior replaced") {
          actual.renameSync(priorPath, `${priorPath}-saved`);
          mkdirSync(priorPath);
          writeFileSync(join(priorPath, "authored.md"), "keep authored content");
        }
        throw eio();
      }
      if (scenario === "rename fails" && String(from).includes(".topik-compilation-prior-"))
        throw eio();
      actual.renameSync(from, to);
    });
    await expect(handler(options())).rejects.toMatchObject({
      message: expect.stringContaining("retained for recovery"),
      cause: expect.any(AggregateError),
    });
    const names = await readdir(dir);
    expect(names.some((name) => name.startsWith(".topik-compilation-generation-"))).toBe(false);
    const saved = names.find(
      (name) =>
        name.startsWith(".topik-compilation-prior-") &&
        (scenario !== "prior replaced" || name.endsWith("-saved")),
    )!;
    expect(saved).toBeDefined();
    expect(await snapshot(join(dir, saved))).toEqual(previous);
    expect(await readFile(join(dir, "intro.md"), "utf8")).toBe("# Updated\n");
    if (scenario === "target appears")
      expect(await readFile(join(dir, ".topik/authored.md"), "utf8")).toBe("keep authored content");
    if (scenario === "prior replaced")
      expect(await readFile(join(dir, saved.replace(/-saved$/, ""), "authored.md"), "utf8")).toBe(
        "keep authored content",
      );
    // Recovery can be completed later without losing any bytes.
    if (scenario === "rename fails") {
      actual.renameSync(join(dir, saved), join(dir, ".topik"));
      vi.mocked(renameSync).mockImplementation(actual.renameSync);
      await handler(options());
      expect(await snapshot(join(dir, ".topik"))).not.toEqual(previous);
    }
  },
);
