import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { ManifestSourceError } from "@topik/core";
import { compile } from "./index";
import { formatPublicCliError } from "../errors";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function snapshot(dir: string): Promise<Record<string, string>> {
  const paths = await readdir(dir, { recursive: true, withFileTypes: true });
  const result: Record<string, string> = {};
  for (const path of paths)
    if (path.isFile()) {
      const fullPath = join(path.parentPath, path.name);
      result[fullPath.slice(dir.length + 1)] = (await readFile(fullPath)).toString("base64");
    }
  return result;
}
const handler = (
  compile as unknown as {
    handler: (options: {
      dir: string;
      format: "json";
      dryRun: boolean;
      validate: boolean;
      links: "error";
      sourceNamespace?: string;
    }) => Promise<void>;
  }
).handler;

test("manifest produces one generation and failures preserve prior output", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const dir = await mkdtemp(join(tmpdir(), "topik-manifest-cli-"));
  roots.push(dir);
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "docs", "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation: [index]");
  await writeFile(join(dir, "docs", "index.md"), "# Docs");
  await writeFile(
    join(dir, ".topik.yaml"),
    "version: 1\nsources: [{kind: wiki, config: docs/wiki.yaml}]",
  );
  const options = {
    dir,
    format: "json" as const,
    dryRun: false,
    validate: true,
    links: "error" as const,
  };
  await handler(options);
  const output = join(dir, ".topik");
  const before = await snapshot(output);
  expect(Object.keys(before)).toContain("resources/Wiki/docs.json");
  for (const manifest of [
    "version: 2\nsources: []",
    "version: 1\nsources: [{kind: wiki, config: docs/wiki.yaml}, {kind: collection, config: absent.yaml}]",
    "version: 1\nsources: [{kind: wiki, config: docs/wiki.yaml}, {kind: wiki, config: duplicate.yaml}]",
  ]) {
    await writeFile(join(dir, "duplicate.yaml"), "id: docs\ntitle: Duplicate");
    await writeFile(join(dir, ".topik.yaml"), manifest);
    await expect(handler(options)).rejects.toThrow();
    expect(await snapshot(output)).toEqual(before);
  }
  await writeFile(join(dir, ".topik.yaml"), "version: 1\nsources: []");
  await handler(options);
  expect(Object.keys(await snapshot(output)).sort()).toEqual([
    "materialization.json",
    "semantic.json",
  ]);
  expect(await readFile(join(dir, "docs", "index.md"), "utf8")).toBe("# Docs");
});

test("manifest diagnostics show safe entry, kind, and root-relative config", () => {
  expect(
    formatPublicCliError(new ManifestSourceError("config-not-found", 2, "wiki", "docs/wiki.yaml")),
  ).toBe(
    ".topik.yaml sources[2] (wiki) docs/wiki.yaml: Required configuration file was not found.",
  );
  expect(
    formatPublicCliError(
      new ManifestSourceError("config-read-failed", 0, "collection", "/private/secret.yaml"),
    ),
  ).not.toContain("private");
});
