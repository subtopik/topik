import { describe, expect, test } from "vite-plus/test";
import { parseSafeConfigurationYaml } from "../compile/config";
import { parseTopikManifest } from "./manifest";

describe("manifest data parsing", () => {
  test("accepts minimal, ordered and empty manifests", () => {
    expect(
      parseTopikManifest(
        parseSafeConfigurationYaml("version: 1\nnamespace: example/project\nsources: []"),
      ),
    ).toEqual({
      version: 1,
      namespace: "example/project",
      sources: [],
    });
    expect(
      parseTopikManifest(
        parseSafeConfigurationYaml(
          "version: 1\nnamespace: example/project\nsources:\n  - kind: wiki\n    config: docs/custom.yml\n  - kind: collection\n    config: guides/custom.json",
        ),
      ).sources.map((source) => source.kind),
    ).toEqual(["wiki", "collection"]);
  });
  test.each([
    [
      "duplicate mapping key",
      "version: 1\nnamespace: example/project\nversion: 1\nnamespace: example/project\nsources: []",
    ],
    [
      "duplicate source field",
      "version: 1\nnamespace: example/project\nsources: [{kind: wiki, kind: collection, config: a.yaml}]",
    ],
    ["custom tag", "version: 1\nnamespace: example/project\nsources: [!executable {}]"],
    ["recursive alias", "version: 1\nnamespace: example/project\nsources: &a [*a]"],
    ["complex mapping key", "? [version]\n: 1\nsources: []"],
    ["deep nesting", "[".repeat(40) + "0" + "]".repeat(40)],
    ["oversized input", "#".repeat(1_048_577)],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseSafeConfigurationYaml(raw)).toThrow();
  });
  test("bounds source count and rejects missing and unknown root fields", () => {
    expect(() => parseTopikManifest({ version: 1 })).toThrow();
    expect(() =>
      parseTopikManifest({ version: 1, sources: [], namespace: "repo", extra: true }),
    ).toThrow();
    expect(() =>
      parseTopikManifest({
        version: 1,
        namespace: "example/project",
        sources: Array.from({ length: 1_001 }, (_, i) => ({
          kind: "wiki",
          config: `wiki-${i}.yaml`,
        })),
      }),
    ).toThrow();
  });
  test.each([undefined, "", "  ", 42, "line\nbreak", "x".repeat(1025)])(
    "rejects invalid namespace %j",
    (namespace) => {
      expect(() => parseTopikManifest({ version: 1, namespace, sources: [] })).toThrow();
    },
  );
  test("normalizes equivalent Unicode namespace spellings", () => {
    expect(parseTopikManifest({ version: 1, namespace: "e\u0301", sources: [] }).namespace).toBe(
      "é",
    );
  });
  test("path collisions identify the conflicting declaration", () => {
    expect(() =>
      parseTopikManifest({
        version: 1,
        namespace: "example/project",
        sources: [
          { kind: "wiki", config: "docs/config.yaml" },
          { kind: "collection", config: "docs/config.yaml" },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["sources", 1, "config"] }),
        ]),
      }),
    );
  });
});
