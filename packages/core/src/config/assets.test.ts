import { describe, expect, test } from "vite-plus/test";
import { parseCollectionConfig } from "./collection";
import { parseWikiConfig } from "./wiki";

const base = { id: "docs", title: "Docs" };
for (const [kind, parse] of [
  ["wiki", parseWikiConfig],
  ["collection", parseCollectionConfig],
] as const) {
  describe(`${kind} source asset configuration`, () => {
    test("defaults new media to _assets without requiring configuration", () => {
      expect(parse(base).assets).toEqual({ directory: "_assets" });
      expect(parse({ ...base, assets: {} }).assets).toEqual({ directory: "_assets" });
    });
    test("accepts an explicit local destination, including nested directories", () => {
      expect(parse({ ...base, assets: { directory: "media/uploads" } }).assets).toEqual({
        directory: "media/uploads",
      });
    });
    test.each([
      "",
      ".",
      "..",
      "../shared",
      "/assets",
      "C:\\assets",
      "https://example.org/assets",
      "media/../assets",
      "media//assets",
      "media/",
      ".git/media",
      ".topik/media",
      "e\u0301/assets",
    ])("rejects unsafe or noncanonical directory %s", (directory) => {
      expect(() => parse({ ...base, assets: { directory } })).toThrow();
    });
    test("rejects malformed settings and unknown asset options", () => {
      for (const assets of [
        null,
        "media",
        [],
        { directory: 1 },
        { directroy: "media" },
        { directory: "media", cleanup: true },
      ]) {
        expect(() => parse({ ...base, assets })).toThrow();
      }
    });
  });
}
