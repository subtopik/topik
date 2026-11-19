import type { TopikContentDiagnostic } from "@topik/content";
import { describe, expect, test } from "vite-plus/test";
import { topikAssetDiagnostic } from "./assets/diagnostics";
import { AssetCompilationError } from "./compile/assets";
import { PublicCompileError } from "./compile/public-errors";
import { CompileError } from "./compile/shared";
import { PREVIEW_DIAGNOSTIC_LIMIT } from "./preview";
import {
  previewErrorDiagnostics,
  previewResultDiagnostics,
  type ResourcesByPath,
} from "./watch-diagnostics";

const resources: ResourcesByPath = new Map([
  ["wiki/intro.md", { type: "Wiki", name: "handbook" }],
  ["people/alice.yaml", { type: "Person", name: "alice" }],
]);

function diagnostic(
  overrides: Partial<TopikContentDiagnostic> & Pick<TopikContentDiagnostic, "id" | "level">,
): TopikContentDiagnostic {
  return { message: "Something is off.", lines: [], ...overrides } as TopikContentDiagnostic;
}

describe("previewErrorDiagnostics", () => {
  test("locates content diagnostics by path, line and column and names their resource", () => {
    const error = new CompileError([
      diagnostic({
        id: "link-page-not-found",
        level: "error",
        file: "wiki/intro.md",
        lines: [12, 13],
        column: 5,
      }),
    ]);
    expect(previewErrorDiagnostics(error, resources)).toEqual({
      diagnostics: [
        {
          id: "link-page-not-found",
          message: "Internal link target page was not found.",
          severity: "error",
          location: { path: "wiki/intro.md", line: 12, column: 5 },
          resource: { type: "Wiki", name: "handbook" },
        },
      ],
    });
  });

  test("keeps a path without a resource and drops invalid positions", () => {
    const error = new CompileError([
      diagnostic({ id: "unknown-tag", level: "critical", file: "new.md", lines: [0], column: 3 }),
    ]);
    expect(previewErrorDiagnostics(error, resources).diagnostics).toEqual([
      expect.objectContaining({ severity: "error", location: { path: "new.md" } }),
    ]);
    expect(previewErrorDiagnostics(error, resources).diagnostics[0]).not.toHaveProperty("resource");
  });

  test("publishes no location for a path the label policy cannot show", () => {
    const error = new CompileError([
      diagnostic({
        id: "link-page-not-found",
        level: "error",
        file: "wiki/a\u202eb.md",
        lines: [2],
      }),
    ]);
    const [published] = previewErrorDiagnostics(error, resources).diagnostics;
    expect(published).toMatchObject({ id: "link-page-not-found", severity: "error" });
    expect(published).not.toHaveProperty("location");
    expect(published).not.toHaveProperty("resource");
  });

  test("keeps warnings of a failed compile after its errors and drops informational levels", () => {
    const error = new CompileError([
      diagnostic({ id: "first-warning", level: "warning" }),
      diagnostic({ id: "a-note", level: "info" }),
      diagnostic({ id: "the-error", level: "error" }),
    ]);
    expect(
      previewErrorDiagnostics(error, resources).diagnostics.map(({ id, severity }) => ({
        id,
        severity,
      })),
    ).toEqual([
      { id: "the-error", severity: "error" },
      { id: "first-warning", severity: "warning" },
    ]);
  });

  test("reports a public compile error with its location and resource", () => {
    const error = new PublicCompileError("author-not-found", "people/alice.yaml");
    expect(previewErrorDiagnostics(error, resources)).toEqual({
      diagnostics: [
        {
          id: "author-not-found",
          message: "An author must reference a Person in the declared project.",
          severity: "error",
          location: { path: "people/alice.yaml" },
          resource: { type: "Person", name: "alice" },
        },
      ],
    });
  });

  test("reports asset failures with their stable IDs, paths and fixed wording", () => {
    const error = new AssetCompilationError("Asset file /private/source/a.png is missing", [
      topikAssetDiagnostic("TOPIK_ASSET_FILE_MISSING", "File /private/source/a.png is missing", {
        location: { path: "wiki/intro.md" },
      }),
    ]);
    const { diagnostics } = previewErrorDiagnostics(error, resources);
    expect(diagnostics).toEqual([
      {
        id: "TOPIK_ASSET_FILE_MISSING",
        message: "An image or download could not be compiled.",
        severity: "error",
        location: { path: "wiki/intro.md" },
        resource: { type: "Wiki", name: "handbook" },
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("/private/source");
  });

  test("reports an asset failure without diagnostics as one error", () => {
    expect(previewErrorDiagnostics(new AssetCompilationError("boom"), resources)).toEqual({
      diagnostics: [
        {
          id: "asset-compilation-failed",
          message: "An image or download could not be compiled.",
          severity: "error",
        },
      ],
    });
  });

  test("reports an unknown error without its text", () => {
    const { diagnostics } = previewErrorDiagnostics(
      new Error("ENOENT /private/source/wiki/intro.md"),
      resources,
    );
    expect(diagnostics).toEqual([
      {
        id: "compilation-failed",
        message: "Compilation failed. Check the source and try again.",
        severity: "error",
      },
    ]);
  });

  test("caps the list and counts the rest, keeping errors before warnings", () => {
    const warnings = Array.from({ length: 10 }, (_, index) =>
      diagnostic({ id: `warning-${index}`, level: "warning" }),
    );
    const errors = Array.from({ length: PREVIEW_DIAGNOSTIC_LIMIT }, (_, index) =>
      diagnostic({ id: `error-${index}`, level: "error" }),
    );
    const result = previewErrorDiagnostics(new CompileError([...warnings, ...errors]), resources);
    expect(result.diagnostics).toHaveLength(PREVIEW_DIAGNOSTIC_LIMIT);
    expect(result.diagnostics.every((entry) => entry.severity === "error")).toBe(true);
    expect(result.omittedDiagnostics).toBe(10);
  });
});

describe("previewResultDiagnostics", () => {
  test("publishes warnings of a successful compile", () => {
    expect(
      previewResultDiagnostics(
        [
          diagnostic({
            id: "link-fragment-not-found",
            level: "warning",
            file: "wiki/intro.md",
            lines: [4],
          }),
          diagnostic({ id: "a-note", level: "info", file: "wiki/intro.md", lines: [5] }),
        ],
        resources,
      ),
    ).toEqual({
      diagnostics: [
        {
          id: "link-fragment-not-found",
          message: "Link target heading was not found.",
          severity: "warning",
          location: { path: "wiki/intro.md", line: 4 },
          resource: { type: "Wiki", name: "handbook" },
        },
      ],
    });
  });

  test("publishes nothing for a clean compile", () => {
    expect(previewResultDiagnostics([], resources)).toEqual({ diagnostics: [] });
  });
});
