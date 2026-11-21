import { expect, test } from "vite-plus/test";
import { isTopikDownloadOnlyMediaType, isTopikWatchIgnoredName } from "./index";

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
