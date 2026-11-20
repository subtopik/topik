import { expect, test } from "vite-plus/test";
import {
  compileTopikContent,
  extractTopikAssetOccurrences,
  formatTopikContent,
  isContentTag,
  parseDocument,
  parseTopikContent,
  removeInvalidTopikAssetReferences,
  transformTopikContent,
  validateDocument,
  writeDocument,
  type RenderableTreeNode,
} from "../index.js";
import { rewriteTopikAssetOccurrences } from "../rewrite.js";
import { parse, withoutPositions } from "../test-helpers.js";

function diagnosticIds(source: string): (string | undefined)[] {
  const result = parseDocument(source);
  return result.ok ? [] : result.diagnostics.map((item) => item.id);
}

function videos(node: RenderableTreeNode): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(videos);
  if (!isContentTag(node)) return [];
  return [
    ...(node.name === "TopikVideo" ? [node.attributes] : []),
    ...node.children.flatMap(videos),
  ];
}

test("video round-trips every attribute", () => {
  const source =
    '{% video src="media/intro.mp4" title="Intro" caption="A tour" poster="media/intro.png" loop=true /%}';
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    name: "video",
    props: {
      src: "media/intro.mp4",
      title: "Intro",
      caption: "A tour",
      poster: "media/intro.png",
      loop: true,
    },
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("video requires a source and a title", () => {
  expect(diagnosticIds('{% video title="Intro" /%}')).toContain("attribute-missing-required");
  expect(diagnosticIds('{% video src="media/intro.mp4" /%}')).toContain(
    "attribute-missing-required",
  );
});

test("video is a self-closing block without children", () => {
  expect(diagnosticIds('{% video src="a.mp4" title="Intro" %}\nText\n{% /video %}')).toContain(
    "topik-video-children",
  );
  expect(diagnosticIds('Watch {% video src="a.mp4" title="Intro" /%} now.')).not.toEqual([]);
});

test("video is allowed where figure is", () => {
  const source = [
    "{% tabs %}",
    '{% tab title="Watch" %}',
    '{% video src="a.mp4" title="Intro" /%}',
    "{% /tab %}",
    "{% /tabs %}",
    "",
    "{% steps %}",
    "{% step %}",
    '{% video src="b.webm" title="Step" /%}',
    "{% /step %}",
    "{% /steps %}",
    "",
    '{% accordion title="More" %}',
    '{% video src="https://videos.example.com/c.mp4" title="More" /%}',
    "{% /accordion %}",
  ].join("\n");
  expect(parseDocument(source)).toMatchObject({ ok: true });
});

test("the title cannot be blank, unless a template variable fills it", () => {
  for (const title of ['"   "', '""', 't"  "'])
    expect(
      diagnosticIds(`{% video src="https://videos.example.com/a.mp4" title=${title} /%}`),
    ).toContain("topik-video-title");
  expect(
    parseDocument('{% video src="https://videos.example.com/a.mp4" title=t"{% $name %}" /%}'),
  ).toMatchObject({ ok: true });
});

test("loop must be a boolean", () => {
  expect(diagnosticIds('{% video src="a.mp4" title="Intro" loop="yes" /%}')).toContain(
    "attribute-type-invalid",
  );
});

test("title and caption accept text templates; sources stay literal", () => {
  expect(
    parseDocument('{% video src="a.mp4" title=t"Intro for {% $name %}" caption=t"{% $name %}" /%}'),
  ).toMatchObject({ ok: true });
  expect(diagnosticIds('{% video src=t"{% $file %}" title="Intro" /%}')).toContain(
    "topik-template-location",
  );
});

test("video declares a video source slot and an image poster slot", () => {
  const occurrences = extractTopikAssetOccurrences(
    '{% video src="media/intro.mp4" title="Intro" caption="A tour" poster="media/intro.png" /%}',
  );
  expect(occurrences).toEqual([
    expect.objectContaining({
      slot: "video.src",
      role: "video",
      reference: "media/intro.mp4",
      kind: "local",
      position: "/children/0/attributes/src",
      semantics: { title: "Intro", caption: "A tour" },
    }),
    expect.objectContaining({
      slot: "video.poster",
      role: "image",
      reference: "media/intro.png",
      kind: "local",
      position: "/children/0/attributes/poster",
      semantics: { title: "Intro", caption: "A tour" },
    }),
  ]);
});

test("external HTTPS sources keep their query, such as a signed URL", () => {
  const url = "https://cdn.example.com/media?id=42&sig=abc";
  const source = `{% video src="${url}" title="Intro" /%}`;
  expect(extractTopikAssetOccurrences(source)).toEqual([
    expect.objectContaining({ slot: "video.src", kind: "external-https" }),
  ]);
  const compiled = compileTopikContent(source);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  expect(videos(compiled.tree)).toEqual([{ src: url, title: "Intro", loop: false }]);
  const formatted = formatTopikContent(source);
  expect(formatted).toMatchObject({ ok: true, formatted: `${source}\n` });
});

test("a YouTube URL belongs in the youtube component", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s",
    "https://youtu.be/dQw4w9WgXcQ",
  ])
    expect(diagnosticIds(`{% video src="${url}" title="Intro" /%}`)).toContain(
      "topik-video-youtube",
    );
});

test("template titles are reported as detached templates", () => {
  const [occurrence] = extractTopikAssetOccurrences(
    '{% video src="a.mp4" title=t"Intro for {% $name %}" /%}',
  );
  expect(occurrence.semantics.title).toBeUndefined();
  expect(occurrence.semantics.titleTemplate).toMatchObject({ type: "topikTextTemplate" });
});

test("rewrites the source and poster slots independently", () => {
  const source = '{% video src="old.mp4" title="Intro" poster="old.png" /%}';
  const rewritten = rewriteTopikAssetOccurrences(source, (occurrence) =>
    occurrence.slot === "video.src" ? "media/new.mp4" : "media/new.png",
  );
  expect(rewritten.ok).toBe(true);
  if (!rewritten.ok) return;
  expect(rewritten.content).toContain('src="media/new.mp4"');
  expect(rewritten.content).toContain('poster="media/new.png"');
});

test("unsafe sources fail validation", () => {
  for (const source of [
    '{% video src="http://example.com/a.mp4" title="Intro" /%}',
    '{% video src="javascript:alert(1)" title="Intro" /%}',
    '{% video src="a.mp4" title="Intro" poster="http://example.com/a.png" /%}',
  ])
    expect(compileTopikContent(source).ok).toBe(false);
});

test("an unsafe poster is dropped and the video stays", () => {
  const source = '{% video src="a.mp4" title="Intro" poster="http://example.com/a.png" /%}';
  const document = parseTopikContent(source);
  removeInvalidTopikAssetReferences(document, source);
  expect(validateDocument(document)).toEqual([]);
  expect(videos(transformTopikContent(document))).toEqual([
    { src: "a.mp4", title: "Intro", loop: false },
  ]);
});

test("an unsafe source keeps template variables in the remaining text", () => {
  const source =
    '{% video src="http://example.com/a.mp4" title=t"Intro for {% $name %}" caption=t"Tour" /%}';
  const document = parseTopikContent(source);
  removeInvalidTopikAssetReferences(document, source);
  expect(validateDocument(document)).toEqual([]);
  expect(JSON.stringify(document)).not.toContain("example.com");
  expect(
    transformTopikContent(document, { components: {}, variables: { name: "Ada" } }),
  ).toMatchObject({ children: [{ name: "p", children: ["Intro for Ada\nTour"] }] });
});

test("an unsafe source leaves the title and caption as text", () => {
  const source = '{% video src="http://example.com/a.mp4" title="Intro" caption="A tour" /%}';
  const document = parseTopikContent(source);
  removeInvalidTopikAssetReferences(document, source);
  expect(validateDocument(document)).toEqual([]);
  expect(transformTopikContent(document)).toMatchObject({
    children: [{ name: "p", children: ["Intro\nA tour"] }],
  });
});
