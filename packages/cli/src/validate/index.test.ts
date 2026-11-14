import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
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
    vi.restoreAllMocks();
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

  test("fails visibly for a known resource with an unsupported version", async () => {
    const filePath = join(dir, "future-wiki.yaml");
    await writeFile(
      filePath,
      ["apiVersion: v2", "type: Wiki", "name: docs", "spec:", "  title: Docs", ""].join("\n"),
    );

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = await captureFailure(() =>
      (validate as ValidateCommand).handler?.({ path: filePath }),
    );
    expect(failure).toBeInstanceOf(PublicCliError);
    expect(failure).toMatchObject({ id: "resource-validation-failed" });
    expect(formatPublicCliError(failure)).toBe("Resource validation failed.");
    expect(error).toHaveBeenCalledWith(
      "future-wiki.yaml: Wiki/docs: /apiVersion Unsupported resource apiVersion\n\n" +
        "1 validation error(s) in 1 resources while validating resources",
    );
  });

  test("reports which file and resource failed with sanitized labels", async () => {
    const sentinel = "PRIVATE VALUE";
    await mkdir(join(dir, "Wiki"), { recursive: true });
    await writeFile(
      join(dir, "Wiki", "docs.json"),
      JSON.stringify({ apiVersion: "v1", type: "Wiki", name: "docs", spec: { title: 1 } }),
    );
    await writeFile(
      join(dir, `${sentinel}.json`),
      JSON.stringify({
        apiVersion: sentinel,
        type: "Wiki",
        name: sentinel,
        spec: { title: "Docs" },
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect((validate as ValidateCommand).handler?.({ path: dir })).rejects.toMatchObject({
      id: "resource-validation-failed",
    });

    const output = error.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toBe(
      [
        "resource file: Wiki/unknown: /apiVersion Unsupported resource apiVersion",
        "Wiki/docs.json: Wiki/docs: /spec/title must be string",
        "",
        "2 validation error(s) in 2 resources while validating resources",
      ].join("\n"),
    );
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain(dir);
  });

  test("validates a compilation output tree without treating its descriptors as resources", async () => {
    const out = join(dir, ".topik");
    await mkdir(join(out, "resources", "Wiki"), { recursive: true });
    await mkdir(join(out, "blobs"));
    await writeFile(join(out, "materialization.json"), JSON.stringify({ resources: [] }));
    await writeFile(join(out, "semantic.json"), JSON.stringify({ names: [] }));
    await writeFile(
      join(out, "resources", "Wiki", "docs.json"),
      JSON.stringify({ apiVersion: "v1", type: "Wiki", name: "docs", spec: { title: "Docs" } }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect((validate as ValidateCommand).handler?.({ path: out })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Validated 1 resources");
  });

  test("skips node_modules and dot-directories while walking a directory", async () => {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, ".cache"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "package.json"), "{ not json");
    await writeFile(join(dir, ".cache", "broken.yaml"), "a: [");
    await writeFile(
      join(dir, "docs.yaml"),
      ["apiVersion: v1", "type: Wiki", "name: docs", "spec:", "  title: Docs", ""].join("\n"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect((validate as ValidateCommand).handler?.({ path: dir })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Validated 1 resources");

    await expect(
      (validate as ValidateCommand).handler?.({ path: join(dir, ".cache") }),
    ).rejects.toMatchObject({ id: "resource-yaml-invalid" });
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
