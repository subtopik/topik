import { AssetCompilationError } from "@topik/core";
import { expect, test } from "vite-plus/test";
import { formatPublicCliError } from "./errors";

const diagnostic = (id: string, path?: string) =>
  ({
    id,
    correlationId: "c",
    severity: "error",
    consequence: "block-resource",
    descriptorVersion: "v1",
    location: path === undefined ? {} : { path },
    recovery: "restore-file",
    message: "PRIVATE wording that is not a stable surface",
  }) as unknown as AssetCompilationError["diagnostics"][number];

test("an asset failure names the file and the known cause", () => {
  expect(
    formatPublicCliError(
      new AssetCompilationError(
        "Local Asset bytes could not be proven",
        [diagnostic("TOPIK_ASSET_FILE_TYPE_UNSUPPORTED", "images/pic.png")],
        { reason: "git-lfs-pointer" },
      ),
    ),
  ).toBe(
    "images/pic.png: An image or download could not be read. The file is a Git LFS pointer; run git lfs pull to fetch its content.",
  );
});

test("an asset failure without a known cause prints the diagnostic ID, never its wording", () => {
  const message = formatPublicCliError(
    new AssetCompilationError("internal", [diagnostic("TOPIK_ASSET_FILE_MISSING", "pic.png")]),
  );
  expect(message).toBe(
    "pic.png: An image or download could not be compiled (TOPIK_ASSET_FILE_MISSING).",
  );
  expect(message).not.toContain("PRIVATE");
});

test("an asset failure without a safe path or a plain ID stays generic about them", () => {
  expect(formatPublicCliError(new AssetCompilationError("internal"))).toBe(
    "An image or download could not be compiled.",
  );
  expect(
    formatPublicCliError(
      new AssetCompilationError("internal", [diagnostic("not a plain id", "/abs/secret/pic.png")]),
    ),
  ).not.toMatch(/secret|not a plain id/u);
});
