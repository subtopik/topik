import { expect, test } from "vite-plus/test";
import {
  compileTopikContent,
  extractTopikAssetOccurrences,
  formatTopikContent,
  isContentTag,
  parseDocument,
  parseTopikYouTubeUrl,
  topikYouTubeEmbedUrl,
  topikYouTubeWatchUrl,
  type RenderableTreeNode,
} from "../index.js";

function diagnosticIds(source: string): (string | undefined)[] {
  const result = parseDocument(source);
  return result.ok ? [] : result.diagnostics.map((item) => item.id);
}

function players(node: RenderableTreeNode): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(players);
  if (!isContentTag(node)) return [];
  return [
    ...(node.name === "TopikYouTube" ? [node.attributes] : []),
    ...node.children.flatMap(players),
  ];
}

test.each([
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", { id: "dQw4w9WgXcQ" }],
  ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=90", { id: "dQw4w9WgXcQ", start: 90 }],
  ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=90s", { id: "dQw4w9WgXcQ", start: 90 }],
  ["https://youtu.be/dQw4w9WgXcQ?t=1h2m3s", { id: "dQw4w9WgXcQ", start: 3723 }],
  ["https://www.youtube.com/shorts/dQw4w9WgXcQ", { id: "dQw4w9WgXcQ" }],
  ["https://www.youtube.com/live/dQw4w9WgXcQ", { id: "dQw4w9WgXcQ" }],
  ["https://www.youtube.com/embed/dQw4w9WgXcQ?start=5", { id: "dQw4w9WgXcQ", start: 5 }],
  ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", { id: "dQw4w9WgXcQ" }],
])("reads %s", (url, video) => {
  expect(parseTopikYouTubeUrl(url)).toEqual(video);
});

test.each([
  "http://youtu.be/dQw4w9WgXcQ",
  "https://user@youtu.be/dQw4w9WgXcQ",
  "https://youtu.be:8443/dQw4w9WgXcQ",
  "https://youtube.com/watch?v=short",
  "https://www.youtube.com/channel/dQw4w9WgXcQ",
  "https://example.com/watch?v=dQw4w9WgXcQ",
  " https://youtu.be/dQw4w9WgXcQ",
  "youtu.be/dQw4w9WgXcQ",
])("refuses %s", (url) => {
  expect(parseTopikYouTubeUrl(url)).toBeUndefined();
});

test("a start time that is not a time is ignored", () => {
  expect(parseTopikYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=soon")).toEqual({
    id: "dQw4w9WgXcQ",
  });
});

test("watch and embed URLs keep the start time", () => {
  const video = { id: "dQw4w9WgXcQ", start: 90 };
  expect(topikYouTubeWatchUrl(video)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s");
  expect(topikYouTubeEmbedUrl(video)).toBe(
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=90",
  );
  expect(topikYouTubeEmbedUrl({ id: "dQw4w9WgXcQ" })).toBe(
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1",
  );
});

test("youtube compiles to TopikYouTube with the authored source, and formats unchanged", () => {
  const source =
    '{% youtube caption="Two minutes" src="https://youtu.be/dQw4w9WgXcQ?t=90" title="Installing the CLI" /%}';
  const compiled = compileTopikContent(source);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  expect(players(compiled.tree)).toEqual([
    {
      src: "https://youtu.be/dQw4w9WgXcQ?t=90",
      title: "Installing the CLI",
      caption: "Two minutes",
    },
  ]);
  expect(formatTopikContent(source)).toMatchObject({ ok: true, formatted: `${source}\n` });
  // A YouTube video is not a project file, so it is not an asset.
  expect(extractTopikAssetOccurrences(source)).toEqual([]);
});

test("youtube requires a YouTube video URL and a title that is not blank", () => {
  expect(diagnosticIds('{% youtube src="https://vimeo.com/1" title="Intro" /%}')).toContain(
    "topik-youtube-src",
  );
  for (const title of ['"   "', '""', 't"  "'])
    expect(
      diagnosticIds(`{% youtube src="https://youtu.be/dQw4w9WgXcQ" title=${title} /%}`),
    ).toContain("topik-youtube-title");
  expect(diagnosticIds('{% youtube title="Intro" /%}').length).toBeGreaterThan(0);
  expect(
    parseDocument('{% youtube src="https://youtu.be/dQw4w9WgXcQ" title=t"{% $name %}" /%}'),
  ).toMatchObject({ ok: true });
});

test("youtube is a self-closing block without children, allowed where video is", () => {
  expect(
    diagnosticIds('{% youtube src="https://youtu.be/dQw4w9WgXcQ" title="x" %}\nHi\n{% /youtube %}'),
  ).toContain("topik-youtube-children");
  const nested = [
    "{% tabs %}",
    '{% tab title="Video" %}',
    '{% youtube src="https://youtu.be/dQw4w9WgXcQ" title="Intro" /%}',
    "{% /tab %}",
    "{% /tabs %}",
  ].join("\n");
  expect(parseDocument(nested)).toMatchObject({ ok: true });
});
