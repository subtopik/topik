import { expect, test } from "vite-plus/test";
import { CompileError } from "../compile/shared";
import { ManifestSourceError } from "../compile/manifest";
import { sourcePlanDiagnostics } from "./diagnostics";

const fallback = { code: "source-validation-failed", message: "Source validation failed." };

test("compiler diagnostic transport bounds output and keeps sanitized messages and locations", () => {
  const error = new CompileError(
    Array.from({ length: 80 }, () => ({
      id: "link-fragment-not-found",
      type: "link",
      level: "error" as const,
      message: "private runtime detail",
      file: "/private/checkout/page.md",
      lines: [-1, 0, ...Array.from({ length: 20 }, (_, index) => index + 1)],
    })),
  );
  const diagnostics = sourcePlanDiagnostics(error, fallback);
  expect(diagnostics).toHaveLength(64);
  expect(diagnostics[0]).toEqual({
    code: "link-fragment-not-found",
    message: "Link target heading was not found.",
    path: "page.md",
    lines: [1, 2, 3, 4, 5, 6, 7, 8],
  });
});

test("manifest failures retain declaration context while unknown exceptions keep private details hidden", () => {
  expect(
    sourcePlanDiagnostics(
      new ManifestSourceError("config-invalid", 2, "wiki", "docs/wiki.yaml"),
      fallback,
    ),
  ).toEqual([
    {
      code: "config-invalid",
      message: "Configuration is invalid.",
      path: "docs/wiki.yaml",
      sourceIndex: 2,
      kind: "wiki",
      config: "docs/wiki.yaml",
    },
  ]);
  expect(sourcePlanDiagnostics(new Error("private runtime detail"), fallback)).toEqual([fallback]);
});
