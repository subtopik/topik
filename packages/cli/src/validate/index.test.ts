import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { formatPublicCliError, PublicCliError } from "../errors";
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

  test("keeps JSON bytes and absolute paths out of parse failures", async () => {
    const sentinel = "PRIVATE_VALUE";
    const filePath = join(dir, `${sentinel}.json`);
    await writeFile(filePath, `{ "secret": "${sentinel}"`);

    const failure = await captureFailure(() =>
      (validate as ValidateCommand).handler?.({ path: filePath }),
    );
    expect(failure).toBeInstanceOf(PublicCliError);
    expect(failure).toMatchObject({ id: "resource-json-invalid" });
    expect(formatPublicCliError(failure)).toBe("JSON resource input could not be parsed.");
    expect(publicErrorSurfaces(failure)).not.toContain(sentinel);
    expect(publicErrorSurfaces(failure)).not.toContain(dir);
    expect(publicErrorSurfaces(failure)).not.toContain(tmpdir());
  });

  test("keeps missing input paths and recursive causes out of public surfaces", async () => {
    const sentinel = "PRIVATE_VALUE";
    const filePath = join(dir, sentinel, "missing.json");
    const failure = await captureFailure(() =>
      (validate as ValidateCommand).handler?.({ path: filePath }),
    );
    expect(failure).toBeInstanceOf(PublicCliError);
    expect(failure).toMatchObject({ id: "resource-access-failed" });
    expect(formatPublicCliError(failure)).toBe("Resource input could not be accessed.");
    expect(publicErrorSurfaces(failure)).not.toContain(sentinel);
    expect(publicErrorSurfaces(failure)).not.toContain(dir);
    expect(publicErrorSurfaces(failure)).not.toContain(tmpdir());
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

async function captureFailure(action: () => Promise<unknown> | undefined): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to reject");
}

function publicErrorSurfaces(error: unknown): string {
  const values = [JSON.stringify(error)];
  if (error instanceof Error) {
    values.push(String(error), error.message);
    if (error.cause instanceof Error) values.push(String(error.cause), JSON.stringify(error.cause));
  }
  if (typeof error === "object" && error !== null) {
    values.push(JSON.stringify(Object.keys(error)), JSON.stringify(Object.values(error)));
  }
  return values.join("\n");
}
