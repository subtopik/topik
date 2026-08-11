import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { readConfigFile } from "./config";
import { compileWiki } from "./wiki";
import { PublicCompileError } from "./public-errors";

const execFileAsync = promisify(execFile);
const SENTINEL = "PRIVATE_VALUE";

describe("public compiler error safety", () => {
  let root: string;
  const cleanup: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `topik-${SENTINEL}-`));
    cleanup.push(root);
  });

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  test("sanitizes missing and invalid configuration failures at creation", async () => {
    await expectSafeFailure(() => readConfigFile(root, [`${SENTINEL}.yaml`]), "config-not-found");

    await writeFile(join(root, "wiki.yaml"), `id: docs\ntitle: [${SENTINEL}\n`);
    await expectSafeFailure(() => compileWiki({ dir: root }), "config-parse-failed", "wiki.yaml");

    await writeFile(join(root, "wiki.yaml"), `id: ${SENTINEL}\ntitle: Docs\n`);
    await expectSafeFailure(() => compileWiki({ dir: root }), "config-invalid", "wiki.yaml");
  });

  test("sanitizes non-directory roots and missing Wiki page files", async () => {
    const fileRoot = join(root, "not-a-directory");
    await writeFile(fileRoot, SENTINEL);
    await expectSafeFailure(() => compileWiki({ dir: fileRoot }), "config-read-failed");

    await writeFile(
      join(root, "wiki.yaml"),
      "id: docs\ntitle: Docs\nnavigation:\n  - private-value\n",
    );
    await expectSafeFailure(() => compileWiki({ dir: root }), "wiki-page-not-found");
  });

  test("sanitizes outside-root and special-file failures without exposing causes", async () => {
    const outside = await mkdtemp(join(tmpdir(), `topik-outside-${SENTINEL}-`));
    cleanup.push(outside);
    await writeFile(join(outside, "outside.md"), "# Outside\n");
    await writeFile(join(root, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - outside\n");
    await symlink(join(outside, "outside.md"), join(root, "outside.md"));
    await expectSafeFailure(
      () => compileWiki({ dir: root }),
      "file-outside-compilation-root",
      "outside.md",
    );

    await rm(join(root, "outside.md"));
    await execFileAsync("mkfifo", [join(root, "outside.md")]);
    await expectSafeFailure(() => compileWiki({ dir: root }), "file-not-regular", "outside.md");
  });
});

async function expectSafeFailure(
  action: () => Promise<unknown>,
  id: PublicCompileError["id"],
  location?: string,
): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(PublicCompileError);
  expect(failure).toMatchObject({ id, ...(location === undefined ? {} : { location }) });
  const surfaces = publicErrorSurfaces(failure);
  expect(surfaces).not.toContain(SENTINEL);
  expect(surfaces).not.toContain("private-value");
  expect(surfaces).not.toContain(tmpdir());
}

function publicErrorSurfaces(error: unknown): string {
  const surfaces: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    surfaces.push(JSON.stringify(current));
    if (current instanceof Error) surfaces.push(String(current), current.message);
    if (typeof current !== "object") break;
    surfaces.push(JSON.stringify(Object.keys(current)), JSON.stringify(Object.values(current)));
    current = "cause" in current ? current.cause : undefined;
  }
  return surfaces.join("\n");
}
