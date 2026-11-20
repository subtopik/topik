import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { formatPublicCliError, PublicCliError } from "../errors";
import { validate } from "./index";

type ValidateCommand = {
  handler?: (options: {
    path: string;
    graph?: boolean;
    content?: boolean;
    json?: boolean;
  }) => Promise<void>;
};

const wiki = {
  apiVersion: "v1",
  type: "Wiki",
  name: "docs",
  spec: { title: "Docs", navigation: [{ type: "page", page: "docs-intro", slug: "" }] },
};
const wikiPage = {
  apiVersion: "v1",
  type: "WikiPage",
  name: "docs-intro",
  spec: { wiki: "docs", title: "Intro", content: { format: "topik", value: "# Intro\n" } },
};

describe("validate command opt-in checks", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-validate-checks-"));
    await mkdir(join(dir, "Wiki"));
    await mkdir(join(dir, "WikiPage"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  test("leaves graph and content problems alone unless asked", async () => {
    await writeFile(join(dir, "Wiki", "docs.json"), JSON.stringify(wiki));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect((validate as ValidateCommand).handler?.({ path: dir })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Validated 1 resources");
  });

  test("--graph reports dangling references and duplicates with their files", async () => {
    await writeFile(join(dir, "Wiki", "docs.json"), JSON.stringify(wiki));
    await writeFile(join(dir, "Wiki", "copy.json"), JSON.stringify(wiki));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      (validate as ValidateCommand).handler?.({ path: dir, graph: true }),
    ).rejects.toMatchObject({ id: "resource-validation-failed" });
    expect(error.mock.calls.map((call) => call.join(" ")).join("\n")).toBe(
      [
        "Wiki/copy.json: Wiki/docs: /spec/navigation/0/page must reference a WikiPage in the resource set; WikiPage/docs-intro is missing",
        "Wiki/docs.json: Wiki/docs: /name must be unique: another resource has the same type and name",
        "",
        "2 validation error(s) in 2 resources while validating resources",
      ].join("\n"),
    );
  });

  test("--graph accepts a complete set", async () => {
    await writeFile(join(dir, "Wiki", "docs.json"), JSON.stringify(wiki));
    await writeFile(join(dir, "WikiPage", "docs-intro.json"), JSON.stringify(wikiPage));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      (validate as ValidateCommand).handler?.({ path: dir, graph: true, content: true }),
    ).resolves.toBeUndefined();
  });

  test("--content reports Topik content errors", async () => {
    await writeFile(
      join(dir, "WikiPage", "docs-intro.json"),
      JSON.stringify({
        ...wikiPage,
        spec: {
          ...wikiPage.spec,
          content: { format: "topik", value: "# Intro\n\n<div>x</div>\n" },
        },
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect((validate as ValidateCommand).handler?.({ path: dir })).resolves.toBeUndefined();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      (validate as ValidateCommand).handler?.({ path: dir, content: true }),
    ).rejects.toMatchObject({ id: "resource-validation-failed" });
    expect(error.mock.calls[0]?.[0]).toMatch(
      /^WikiPage\/docs-intro\.json: WikiPage\/docs-intro: \/spec\/content\/value line 3: /u,
    );
  });

  test("--json prints one stable document on stdout and keeps the exit status", async () => {
    const sentinel = "PRIVATE VALUE";
    await writeFile(join(dir, "Wiki", "docs.json"), JSON.stringify(wiki));
    await writeFile(join(dir, "WikiPage", "broken.json"), "{");
    await writeFile(
      join(dir, "WikiPage", "docs-intro.json"),
      JSON.stringify({ ...wikiPage, spec: { ...wikiPage.spec, title: 1 }, [sentinel]: true }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      (validate as ValidateCommand).handler?.({ path: dir, graph: true, json: true }),
    ).rejects.toMatchObject({ id: "resource-validation-failed" });
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain(dir);
    expect(JSON.parse(output)).toEqual({
      version: 1,
      valid: false,
      resources: 2,
      checks: ["schema", "graph"],
      diagnostics: [
        {
          check: "read",
          id: "resource-json-invalid",
          file: "WikiPage/broken.json",
          resource: null,
          pointer: null,
          message: "JSON resource input could not be parsed.",
        },
        {
          check: "schema",
          id: "resource-invalid",
          file: "WikiPage/docs-intro.json",
          resource: "WikiPage/docs-intro",
          pointer: "/",
          message: "must NOT have additional properties",
        },
        {
          check: "schema",
          id: "resource-invalid",
          file: "WikiPage/docs-intro.json",
          resource: "WikiPage/docs-intro",
          pointer: "/spec/title",
          message: "must be string",
        },
      ],
    });
  });

  test("--json reports success and a target that cannot be read", async () => {
    await writeFile(
      join(dir, "Wiki", "docs.json"),
      JSON.stringify({ ...wiki, spec: { title: "Docs" } }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      (validate as ValidateCommand).handler?.({ path: dir, json: true }),
    ).resolves.toBeUndefined();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      version: 1,
      valid: true,
      resources: 1,
      checks: ["schema"],
      diagnostics: [],
    });

    log.mockClear();
    await expect(
      (validate as ValidateCommand).handler?.({ path: join(dir, "missing"), json: true }),
    ).rejects.toMatchObject({ id: "resource-access-failed" });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      version: 1,
      valid: false,
      resources: 0,
      checks: ["schema"],
      diagnostics: [
        {
          check: "read",
          id: "resource-access-failed",
          file: null,
          resource: null,
          pointer: null,
          message: "Resource input could not be accessed.",
        },
      ],
    });
  });
});

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

  test("skips the empty documents around YAML separators", async () => {
    const filePath = join(dir, "wiki.yaml");
    const resource = ["apiVersion: v1", "type: Wiki", "name: docs", "spec:", "  title: Docs"];
    await writeFile(filePath, ["---", ...resource, "---", "---", ""].join("\n"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      (validate as ValidateCommand).handler?.({ path: filePath }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Validated 1 resources");
  });

  test.each(["null", "~", '""', "''", "!!str"])(
    "still validates an explicit %s YAML document",
    async (document) => {
      const filePath = join(dir, "wiki.yaml");
      await writeFile(filePath, `${document}\n---\n`);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(
        (validate as ValidateCommand).handler?.({ path: filePath }),
      ).rejects.toMatchObject({ id: "resource-validation-failed" });
    },
  );

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
      join(dir, "Bad wiki.json"),
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
        "Bad wiki.json: Wiki/unknown: /apiVersion Unsupported resource apiVersion",
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

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      (validate as ValidateCommand).handler?.({ path: join(dir, ".cache") }),
    ).rejects.toMatchObject({ id: "resource-validation-failed" });
  });

  test("names each unparseable file in a directory and keeps validating the rest", async () => {
    const sentinel = "PRIVATE_VALUE";
    await writeFile(join(dir, "a-broken.json"), `{ "secret": "${sentinel}"`);
    await writeFile(join(dir, "b-broken.yaml"), "a: [");
    await writeFile(
      join(dir, "c-invalid.json"),
      JSON.stringify({ apiVersion: "v1", type: "Wiki", name: "docs", spec: { title: 1 } }),
    );
    await writeFile(
      join(dir, "d-valid.yaml"),
      ["apiVersion: v1", "type: Wiki", "name: ok", "spec:", "  title: Docs", ""].join("\n"),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect((validate as ValidateCommand).handler?.({ path: dir })).rejects.toMatchObject({
      id: "resource-validation-failed",
    });

    const output = error.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toBe(
      [
        "a-broken.json: JSON resource input could not be parsed.",
        "b-broken.yaml: YAML resource input could not be parsed.",
        "c-invalid.json: Wiki/docs: /spec/title must be string",
        "",
        "1 validation error(s) in 2 resources while validating resources",
        "2 resource file(s) could not be read or parsed; 2 resources were validated",
      ].join("\n"),
    );
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain(dir);
  });

  test("fails when every resource file in a directory is unparseable", async () => {
    await writeFile(join(dir, "broken.jsonl"), "{\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect((validate as ValidateCommand).handler?.({ path: dir })).rejects.toMatchObject({
      id: "resource-validation-failed",
    });
    expect(error.mock.calls.map((call) => call.join(" "))).toEqual([
      "broken.jsonl: JSONL resource input could not be parsed.",
      "1 resource file(s) could not be read or parsed; 0 resources were validated",
    ]);
  });

  test.each(["json", "jsonl", "yaml"])("accepts a UTF-8 byte order mark in .%s", async (ext) => {
    const resource = { apiVersion: "v1", type: "Wiki", name: "docs", spec: { title: "Docs" } };
    const filePath = join(dir, `wiki.${ext}`);
    await writeFile(filePath, `\uFEFF${JSON.stringify(resource)}\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      (validate as ValidateCommand).handler?.({ path: filePath }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Validated 1 resources");
  });

  test("reports every schema violation in a resource", async () => {
    const filePath = join(dir, "wiki.json");
    await writeFile(filePath, JSON.stringify({ apiVersion: "v1", type: "Wiki", spec: {} }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect((validate as ValidateCommand).handler?.({ path: filePath })).rejects.toMatchObject(
      { id: "resource-validation-failed" },
    );
    expect(error).toHaveBeenCalledWith(
      "wiki.json: Wiki/unknown: / must have required property 'name'\n" +
        "wiki.json: Wiki/unknown: /spec must have required property 'title'\n\n" +
        "2 validation error(s) in 1 resources while validating resources",
    );
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
