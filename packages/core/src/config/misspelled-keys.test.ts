import { expect, test } from "vite-plus/test";
import { parseCollectionConfig } from "./collection";
import { parseWikiConfig } from "./wiki";

const wiki = { id: "docs", title: "Docs" };

test.each(["navigaton", "Navigation", "titel", "descripton", "Id", "lables"])(
  "rejects a likely misspelling of a known Wiki key: %s",
  (key) => {
    expect(() => parseWikiConfig({ ...wiki, [key]: [] })).toThrow(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "unrecognized_keys", keys: [key], path: [] })],
      }),
    );
  },
);

test.each(["custom", "extensions", "x-owner", "ids", "nav"])(
  "keeps unrelated unknown Wiki keys accepted: %s",
  (key) => {
    expect(parseWikiConfig({ ...wiki, [key]: "kept" })).toMatchObject(wiki);
  },
);

test("checks collection keys against the collection schema", () => {
  expect(() => parseCollectionConfig({ ...wiki, tag: ["a"] })).toThrow();
  expect(() => parseCollectionConfig({ ...wiki, persns: [] })).toThrow();
  expect(parseCollectionConfig({ ...wiki, navigation: [] })).toMatchObject(wiki);
});
