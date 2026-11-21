import { expect, test } from "vite-plus/test";
import {
  decodeSource,
  encodeSource,
  inspectSourceSyntax,
  patchSourceFields,
  replaySourceByteEdits,
  utf8Offsets,
} from "./syntax";

test("YAML value patches preserve comments, unknown entries, ordering and CRLF around UTF-8 byte ranges", () => {
  const base = '# context\r\ntitle: "Café" # keep\r\ntags:\r\n  - old\r\ncustom: untouched\r\n';
  const result = patchSourceFields(base, { title: "Changed", tags: ["new"], labels: {} });
  expect(decodeSource(result.bytes)).toBe(
    '# context\r\ntitle: "Changed" # keep\r\ntags:\r\n  ["new"]\r\ncustom: untouched\r\nlabels: {}\r\n',
  );
  expect(replaySourceByteEdits(encodeSource(base), result.edits)).toEqual(result.bytes);
  expect(() =>
    replaySourceByteEdits(encodeSource(base.replace("Café", "Edit")), result.edits),
  ).toThrow();
});

test("JSON patches preserve existing spelling while inserting and removing fields", () => {
  const base =
    '{\n  "title": "Old",\n  "description": null,\n  "labels": {},\n  "custom": [ 1, 2 ]\n}\n';
  const patched = patchSourceFields(
    base,
    { title: "New", description: undefined, labels: undefined },
    true,
  );
  expect(JSON.parse(decodeSource(patched.bytes))).toEqual({
    title: "New",
    custom: [1, 2],
  });
  expect(decodeSource(patched.bytes)).toContain('"custom": [ 1, 2 ]');
  expect(
    JSON.parse(
      decodeSource(
        patchSourceFields('{"a":1,"b":2,"c":3}', { b: undefined, c: undefined }, true).bytes,
      ),
    ),
  ).toEqual({ a: 1 });
});

test("ambiguous syntax and overlapping byte edits fail closed", () => {
  expect(() => patchSourceFields("title: First\ntitle: Second\n", { title: "Third" })).toThrow();
  expect(() =>
    patchSourceFields("title: &name First\ncustom: *name\n", { title: "Third" }),
  ).toThrow();
  const { edits } = patchSourceFields("title: Old\n", { title: "New" });
  expect(() => replaySourceByteEdits(encodeSource("title: Old\n"), [...edits, ...edits])).toThrow();
});

test("nested map deletion and insertion patch exact fields while retaining sibling spelling", () => {
  const base =
    "theme:\n  colors:\n    primary: '#ff0000'\n    dark: '#000000' # keep\n  custom: untouched\n";
  const result = patchSourceFields(base, {
    "theme/colors/primary": undefined,
    "theme/colors/light": "#ffffff",
  });
  expect(decodeSource(result.bytes)).toBe(
    "theme:\n  colors:\n    dark: '#000000' # keep\n    light: \"#ffffff\"\n  custom: untouched\n",
  );
});

test("BOM stays outside first-entry edits and does not count as indentation", () => {
  const raw = "\uFEFFdescription: remove\ncustom: exact\n";
  const result = patchSourceFields(decodeSource(encodeSource(raw)), {
    description: undefined,
  });
  expect(result.bytes).toEqual(encodeSource("\uFEFFcustom: exact\n"));
  expect(replaySourceByteEdits(encodeSource(raw), result.edits)).toEqual(result.bytes);
});

test("new fields in a block-sequence item stay inside the original item", () => {
  const raw = "persons:\n  - id: ada\n    spec:\n      name: Ada\n";
  const result = patchSourceFields(raw, { "persons/ada/labels": { role: "author" } });
  expect(result.bytes).toEqual(
    encodeSource(
      'persons:\n  - id: ada\n    spec:\n      name: Ada\n    labels: {"role":"author"}\n',
    ),
  );
});

test("replacing all block-map entries with new keys does not leave an empty-map marker", () => {
  const base = "labels:\n  old: first\n  other: second\ncustom: exact\n";
  const result = patchSourceFields(base, {
    "labels/old": undefined,
    "labels/other": undefined,
    "labels/new": "replacement",
  });
  expect(decodeSource(result.bytes)).toBe('labels:\n  new: "replacement"\ncustom: exact\n');
});

test("UTF-8 offsets match encoding each prefix, including split surrogate pairs", () => {
  for (const text of [
    "",
    "plain",
    "Café ✓",
    "a😀b",
    "\ud83d",
    "\ude00x",
    "😀😀\ud83d",
    "\u0085\u2028",
  ]) {
    const offset = utf8Offsets(text);
    for (let index = 0; index <= text.length; index++) {
      expect(offset(index), `${JSON.stringify(text)} at ${index}`).toBe(
        encodeSource(text.slice(0, index)).length,
      );
    }
  }
});

test("inspecting a large configuration stays linear in its size", () => {
  const entries = Array.from({ length: 30_000 }, (_, index) => `  - page: page-${index}\n`);
  const raw = `title: Large\nnavigation:\n${entries.join("")}`;
  const started = performance.now();
  inspectSourceSyntax(raw);
  // Re-encoding every prefix took tens of seconds at this size.
  expect(performance.now() - started).toBeLessThan(5_000);
});
