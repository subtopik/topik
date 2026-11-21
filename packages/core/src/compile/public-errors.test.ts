import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { readExactConfigFile } from "./config";
import { compileWiki } from "./wiki";
import { PublicCompileError, publicSchemaError } from "./public-errors";

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
    // The root's path holds the sentinel; only the relative file name may be named.
    await expectSafeFailure(
      () => readExactConfigFile(root, "missing.yaml"),
      "config-not-found",
      "missing.yaml",
    );

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
      "id: docs\ntitle: Docs\nnavigation:\n  - guides/missing\n",
    );
    // The configured relative page path locates the failure, like a missing Course page.
    await expectSafeFailure(
      () => compileWiki({ dir: root }),
      "wiki-page-not-found",
      "guides/missing",
    );
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

describe("public schema error fields", () => {
  test("keeps only a structural field path from schema issues", () => {
    const error = publicSchemaError("config-invalid", "wiki.yaml", {
      issues: [{ code: "invalid_type", path: ["navigation", 2, "title"], message: SENTINEL }],
    });
    expect(error).toMatchObject({ id: "config-invalid", field: "navigation[2].title" });
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });

  test("prefers an unknown key and reports it as the field", () => {
    const error = publicSchemaError("config-invalid", "wiki.yaml", {
      issues: [
        { code: "invalid_type", path: ["title"], message: "missing" },
        { code: "unrecognized_keys", path: [], keys: ["titel"], message: "unknown" },
      ],
    });
    expect(error).toMatchObject({ id: "config-field-unknown", field: "titel" });
  });

  test.each([["/tmp/private-value"], ["has space"], ["a".repeat(300)], ["labels.café"], ["x\ny"]])(
    "omits unsafe field spellings: %j",
    (field) => {
      expect(new PublicCompileError("config-invalid", "wiki.yaml", { field })).not.toHaveProperty(
        "field",
      );
    },
  );

  test.each([
    "guides/getting started.md",
    "wiki/Übersicht.md",
    "wiki/chapter#1/intro.md",
    "people/a@b.yaml",
    "wiki/100%.md",
  ])("keeps a printable relative location as written: %j", (location) => {
    expect(new PublicCompileError("author-not-found", location).location).toBe(location);
  });

  test.each([
    "wiki/a%2Fb.md",
    "guides/a\tb.md",
    "guides/\u202edm.exe",
    "guides/a\u034fb.md",
    "guides/a&#47;b.md",
    "guides/ a.md",
    "a:b.md",
    "../outside.md",
  ])("omits an unsafe location: %j", (location) => {
    expect(new PublicCompileError("author-not-found", location).location).toBeUndefined();
  });

  test("sanitizes related locations like primary locations", () => {
    expect(
      new PublicCompileError("guide-duplicate", "b.md", { relatedLocation: "../outside.md" }),
    ).not.toHaveProperty("relatedLocation");
    expect(
      new PublicCompileError("guide-duplicate", "b.md", { relatedLocation: "a.md" }),
    ).toMatchObject({ relatedLocation: "a.md" });
  });
});
