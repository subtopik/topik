import { expect, test } from "vite-plus/test";
import {
  isTopikDownloadOnlyMediaType,
  isTopikWatchIgnoredName,
  parseTopikByteRange,
} from "./index";

test.each([
  ["node_modules", true],
  [".git", true],
  [".topik", true],
  [".topik-compilation-generation-abc", true],
  [".topik-compilation-prior-abc", true],
  [".github", false],
  ["topik", false],
  [".topikrc", false],
])("watchers ignore %s: %s", (name, ignored) => {
  expect(isTopikWatchIgnoredName(name)).toBe(ignored);
});

test.each([
  ["application/octet-stream", true],
  ["text/html", true],
  ["image/svg+xml", true],
  ["application/x-topik-active-content", true],
  ["image/png", false],
  ["application/pdf", false],
  ["video/mp4", false],
])("%s is served only as a download: %s", (mediaType, download) => {
  expect(isTopikDownloadOnlyMediaType(mediaType)).toBe(download);
});

test.each([
  [undefined, 10, undefined],
  ["bytes=0-3", 10, { start: 0, end: 3 }],
  ["bytes=4-", 10, { start: 4, end: 9 }],
  ["bytes=-3", 10, { start: 7, end: 9 }],
  ["bytes=0-99", 10, { start: 0, end: 9 }],
  ["bytes=10-", 10, "unsatisfiable"],
  ["bytes=-0", 10, "unsatisfiable"],
  ["bytes=3-1", 10, undefined],
  ["bytes=0-1,4-5", 10, undefined],
  ["items=0-1", 10, undefined],
] as const)("parses the range %j of %i bytes", (header, size, expected) => {
  expect(parseTopikByteRange(header, size)).toEqual(expected);
});
