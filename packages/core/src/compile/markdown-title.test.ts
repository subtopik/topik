import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { compile, compileGuides, compileWiki } from "../index";
import { extractMarkdownTitle } from "./shared";

const titleCases = [
  {
    name: "shell comments in backtick fences",
    content: "```sh\n# install prerequisites\nnpm install\n```\n\n# Actual title\n",
    title: "Actual title",
  },
  {
    name: "shell comments in tilde fences",
    content: "~~~sh\n# install prerequisites\n~~~\n\n# Actual title\n",
    title: "Actual title",
  },
  {
    name: "indented code",
    content: "    # install prerequisites\n\n# Actual title\n",
    title: "Actual title",
  },
  {
    name: "Setext H1 headings",
    content: "Actual title\n============\n",
    title: "Actual title",
  },
  {
    name: "closing hashes",
    content: "# Actual title ###\n",
    title: "Actual title",
  },
  {
    name: "explicit heading IDs",
    content: "# Actual title {% #custom-anchor %}\n",
    title: "Actual title",
  },
  {
    name: "inline formatting and entities",
    content: "# **Actual** `title` &amp; [details](https://example.com)\n",
    title: "Actual title & details",
  },
  {
    name: "indented ATX headings and CRLF",
    content: "   # Actual title\r\n\r\nBody.\r\n",
    title: "Actual title",
  },
  {
    name: "the first H1 after lower-level headings",
    content: "## Section\n\n# Actual title\n\n# Later title\n",
    title: "Actual title",
  },
  {
    name: "fence-only fallback",
    content: "```sh\n# install prerequisites\n```\n",
    title: "Getting Started",
  },
  {
    name: "lower-level-only fallback",
    content: "## Section\n\nSetext section\n--------------\n",
    title: "Getting Started",
  },
  {
    name: "empty-heading fallback",
    content: "#\n\nBody.\n",
    title: "Getting Started",
  },
];

describe("Markdown titles", () => {
  test.each(titleCases)("extracts $name", ({ content, title }) => {
    expect(extractMarkdownTitle(content, "getting-started")).toBe(title);
  });
});

describe.each([
  { name: "compileGuides", compiler: compileGuides, kind: "collection", type: "Guide" },
  { name: "compileWiki", compiler: compileWiki, kind: "wiki", type: "WikiPage" },
  { name: "compile collection manifest", compiler: compile, kind: "collection", type: "Guide" },
  { name: "compile wiki manifest", compiler: compile, kind: "wiki", type: "WikiPage" },
] as const)("$name titles through public exports", ({ compiler, kind, type }) => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-markdown-title-"));
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "title-fixture",
        sources: [{ kind, config: `${kind}.yaml` }],
      }),
    );
    await writeFile(
      join(dir, `${kind}.yaml`),
      `id: docs\ntitle: Docs\n${kind === "wiki" ? "navigation: [getting-started]\n" : ""}`,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test.each(titleCases)("compiles $name and preserves source", async ({ content, title }) => {
    const file = join(dir, "getting-started.md");
    await writeFile(file, content);

    const result = await compiler({ dir });
    const resource = result.resources.find((entry) => entry.type === type);

    expect(resource).toMatchObject({
      type,
      spec: { title, content: { format: "topik", value: content } },
    });
    expect(await readFile(file, "utf8")).toBe(content);
  });

  test("preserves an explicit frontmatter title", async () => {
    const title = "Frontmatter title";
    const content = "```sh\n# install prerequisites\n```\n\n# Actual title\n";
    const source = `---\ntitle: ${JSON.stringify(title)}\n---\n${content}`;
    const file = join(dir, "getting-started.md");
    await writeFile(file, source);

    const result = await compiler({ dir });
    const resource = result.resources.find((entry) => entry.type === type);

    expect(resource).toMatchObject({
      type,
      spec: { title, content: { format: "topik", value: content } },
    });
    expect(await readFile(file, "utf8")).toBe(source);
  });

  test("does not replace an invalid explicit empty frontmatter title with a heading", async () => {
    await writeFile(join(dir, "getting-started.md"), '---\ntitle: ""\n---\n# Actual title\n');
    await expect(compiler({ dir })).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          id: "TOPIK_ASSET_SCHEMA_INVALID",
          location: { jsonPointer: "/spec/title" },
        }),
      ],
    });
  });
});
