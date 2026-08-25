import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { listNpmRootMetadata } from "./public-packlist.mjs";

describe("npm root package metadata", () => {
  let directory;

  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  test("includes npm-recognized metadata names and excludes backups and directories", () => {
    directory = mkdtempSync(join(tmpdir(), "topik-packlist-"));
    for (const filename of ["COPYING", "LICENCE.txt", "LICENSE", "README.md", "README.md~"]) {
      writeFileSync(join(directory, filename), `${filename}\n`);
    }
    mkdirSync(join(directory, "license.notice"));

    expect(listNpmRootMetadata(directory)).toEqual([
      "COPYING",
      "LICENCE.txt",
      "LICENSE",
      "README.md",
    ]);
  });
});
