import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { compile, compileCourse, compileGuides, compileWiki, lint } from "./index";

// The recorded output was produced before document admission and analysis were shared across
// compiler phases. Every field of each result, in order, must stay identical. The recordings
// are compared after a canonical JSON round trip so repository formatting cannot affect them.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "topik-pipeline-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
function serialize(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry: unknown) =>
      entry instanceof Uint8Array ? { hex: Buffer.from(entry).toString("hex") } : entry,
    2,
  );
}
async function expectRecorded(value: unknown, name: string): Promise<void> {
  const recorded = await readFile(new URL(`test-fixtures/${name}`, import.meta.url), "utf8");
  expect(serialize(value)).toBe(JSON.stringify(JSON.parse(recorded), null, 2));
}

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

const wikiFiles = {
  "docs/wiki.yaml": `id: docs
title: Docs
navigation:
  - index
  - type: group
    title: Guide
    slug: guide
    children: [setup, usage]
  - type: link
    title: Home
    href: https://example.com
`,
  "docs/index.md": `# Docs

Start with [setup](guide/setup.md) or the [usage notes][usage].

[usage]: guide/usage.md#options

{% card title="Usage" href="./guide/usage.md" /%}

![Logo](images/logo.png "The logo")

{% figure src="images/light.png" darkSrc="images/dark.png" alt="Theme" /%}

[Manual](files/manual.pdf) and [missing](guide/absent.md) and [bad fragment](#nowhere).
`,
  "docs/guide/setup.md": `---
title: Set up
description: First steps
---
# Ignored title

## Install {#install}

Back to [the start](../index.md) and [usage](/guide/usage#options).
`,
  "docs/guide/usage.md": `# Usage

## Options

Same page [anchor](#options) and [setup](setup.md#install).

\`\`\`ts
const value = 1;
\`\`\`
`,
  "docs/images/logo.png": PNG,
  "docs/images/light.png": PNG,
  "docs/images/dark.png": Buffer.concat([PNG, Buffer.from([0])]),
  "docs/files/manual.pdf": Buffer.from("%PDF-1.4\n%%EOF\n"),
};

const guideFiles = {
  "guides/collection.yaml": `sourceVersion: 1
id: guides
title: Guides
tags: [shared]
persons:
  - id: alice
    spec: { name: Alice }
`,
  "guides/first.md": `---
title: First
authors: [alice]
tags: [one]
---
# First guide

Read the [second](second.md#details) guide or [docs](../docs/guide/setup.md).
`,
  "guides/second.md": `# Second

## Details

![Diagram](diagram.png)
`,
  "guides/diagram.png": PNG,
};

const courseFiles = {
  "course/course.yaml": `sourceVersion: 1
id: learning
title: Learning
slug: public-course
modules:
  - id: basics
    title: Basics
    slug: getting-started
    pages: [pages/welcome, pages/next]
`,
  "course/pages/welcome.md": `---
id: welcome
title: Welcome
slug: introduction
---
# Welcome

[Next](next.md#details) and [route](/getting-started/destination).
`,
  "course/pages/next.md": `---
id: next
title: Next
slug: destination
---
# Next

## Details
`,
};

test("manifest compilation output is unchanged", async () => {
  const dir = await fixture({
    ".topik.yaml": JSON.stringify({
      version: 1,
      namespace: "example/pipeline",
      sources: [
        { kind: "wiki", config: "docs/wiki.yaml" },
        { kind: "collection", config: "guides/collection.yaml" },
        { kind: "course", config: "course/course.yaml" },
      ],
    }),
    ...wikiFiles,
    ...guideFiles,
    ...courseFiles,
  });
  const result = await compile({ dir, validation: { links: "warning" } });
  await expectRecorded(result, "pipeline-manifest.json");
});

test("standalone Wiki, Guide and Course compilation output is unchanged", async () => {
  const dir = await fixture({
    "wiki/wiki.yaml": "id: handbook\ntitle: Handbook\nnavigation: [index, other]\n",
    "wiki/index.md": "# Handbook\n\nSee [other](other.md#more) and [nothing](none.md).\n",
    "wiki/other.mdx": "---\ntitle: Other\n---\n## More\n\nText.\n",
    "guides/collection.yaml": "id: notes\ntitle: Notes\ntags: [a]\n",
    "guides/alpha.md": "---\ntags: [b]\nauthors: []\n---\n# Alpha\n\n[Beta](beta.md)\n",
    "guides/beta.md": "Beta has no heading.\n",
    ...courseFiles,
  });
  const results = {
    wiki: await compileWiki({ dir: join(dir, "wiki"), validation: { links: "warning" } }),
    guides: await compileGuides({ dir: join(dir, "guides") }),
    course: await compileCourse({ dir: join(dir, "course") }),
  };
  await expectRecorded(results, "pipeline-standalone.json");
});

test("content and link diagnostics are unchanged", async () => {
  const manifest = (namespace: string) =>
    JSON.stringify({
      version: 1,
      namespace,
      sources: [
        { kind: "wiki", config: "wiki/wiki.yaml" },
        { kind: "collection", config: "guides/collection.yaml" },
      ],
    });
  const invalid = await fixture({
    ".topik.yaml": manifest("example/invalid"),
    "wiki/wiki.yaml": "id: broken\ntitle: Broken\nnavigation: [index, tags, ids]\n",
    "wiki/index.md": "# Broken\n\nFine text.\n",
    "wiki/tags.md": "# Tags\n\n{% unknown %}\n\nText\n{% /unknown %}\n",
    "wiki/ids.md": "## One {#same}\n\n## Two {#same}\n\n[Unsafe](javascript:alert(1))\n",
    "guides/collection.yaml": "id: diag\ntitle: Diagnostics\n",
    "guides/asset.md": "![Bad](asset:not-allowed)\n",
  });
  const links = await fixture({
    ".topik.yaml": manifest("example/links"),
    "wiki/wiki.yaml": "id: linked\ntitle: Linked\nnavigation: [index, other]\n",
    "wiki/index.md": "# Linked\n\n[Missing](missing.md) and [fragment](other.md#absent).\n",
    "wiki/other.md": '# Other\n\n{% card title="Gone" href="./gone.md" /%}\n',
    "guides/collection.yaml": "id: diag\ntitle: Diagnostics\n",
    "guides/ok.md": "# Fine\n\n[Self](#fine) [Gone](#gone) [Folder](./nowhere/)\n",
  });
  const results = {
    invalid: await lint({ dir: invalid }),
    error: await lint({ dir: links }),
    warning: await lint({ dir: links, validation: { links: "warning" } }),
    off: await lint({ dir: links, validation: { links: "off" } }),
  };
  await expectRecorded(results, "pipeline-diagnostics.json");
});
