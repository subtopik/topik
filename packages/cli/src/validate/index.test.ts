import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { CliError } from "../errors";
import { validate } from "./index";

type ValidateCommand = {
  handler?: (options: { path: string }) => Promise<void>;
};

describe("validate command", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-validate-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("accepts YAML resources produced by compile", async () => {
    const filePath = join(dir, "wiki.yaml");
    await writeFile(
      filePath,
      ["apiVersion: v1", "type: Wiki", "name: docs", "spec:", "  title: Docs", ""].join("\n"),
    );

    await expect(
      (validate as ValidateCommand).handler?.({ path: filePath }),
    ).resolves.toBeUndefined();
  });

  test("accepts JSONL resources produced by compile", async () => {
    const filePath = join(dir, "wiki.jsonl");
    await writeFile(
      filePath,
      [
        JSON.stringify({
          apiVersion: "v1",
          type: "Wiki",
          name: "docs",
          spec: { title: "Docs" },
        }),
        JSON.stringify({
          apiVersion: "v1",
          type: "WikiPage",
          name: "docs-intro",
          spec: {
            wiki: "docs",
            title: "Intro",
            content: { format: "topik", value: "# Intro" },
          },
        }),
        "",
      ].join("\n"),
    );

    await expect(
      (validate as ValidateCommand).handler?.({ path: filePath }),
    ).resolves.toBeUndefined();
  });

  test("reports parse errors with file context", async () => {
    const filePath = join(dir, "broken.json");
    await writeFile(filePath, "{");

    await expect((validate as ValidateCommand).handler?.({ path: filePath })).rejects.toThrow(
      CliError,
    );
    await expect((validate as ValidateCommand).handler?.({ path: filePath })).rejects.toThrow(
      `Failed to parse JSON resource file ${filePath}`,
    );
  });

  test("reads supported resource files recursively from directories", async () => {
    await mkdir(join(dir, "Wiki"), { recursive: true });
    await writeFile(
      join(dir, "Wiki", "docs.yaml"),
      ["apiVersion: v1", "type: Wiki", "name: docs", "spec:", "  title: Docs", ""].join("\n"),
    );

    await expect((validate as ValidateCommand).handler?.({ path: dir })).resolves.toBeUndefined();
  });
});
