import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { extractTopikAssetOccurrences } from "@topik/content-schema";
import { parseGeneratedAssetName } from "@topik/schema";
import type {
  Asset,
  Course,
  CourseModule,
  CoursePage,
  GeneratedAssetName,
  Guide,
  Wiki,
  WikiPage,
} from "@topik/schema";
import type { SourceResource } from "../resource";
import { TOPIK_ASSET_LIMITS } from "../portable/constants";
import {
  AssetCompilationError,
  compileAssetResources,
  compileAssetResourcesWithReadHookForTest,
  registerGeneratedAssetPath,
  type CompileAssetResourcesInput,
} from "./assets";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const execFileAsync = promisify(execFile);

const UNSAFE_GENERIC_LINK_CASES: readonly (readonly [
  string,
  (root: string, target: string) => Promise<void>,
])[] = [
  [
    "symlink",
    async (root, target) => {
      await writeFile(join(root, "symlink-source.bin"), "bytes\n");
      await symlink("symlink-source.bin", target);
    },
  ],
  [
    "directory symlink",
    async (root, target) => {
      await mkdir(join(root, "symlink-directory"));
      await symlink("symlink-directory", target, "dir");
    },
  ],
  [
    "executable",
    async (_root, target) => {
      await writeFile(target, "#!/bin/sh\n");
      await chmod(target, 0o755);
    },
  ],
  [
    "hardlink",
    async (root, target) => {
      const source = join(root, "hardlink-source.bin");
      await writeFile(source, "bytes\n");
      await link(source, target);
    },
  ],
  [
    "Git LFS pointer",
    async (_root, target) => {
      await writeFile(
        target,
        `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1\n`,
      );
    },
  ],
  [
    "Git content filter",
    async (root, target) => {
      await writeFile(join(root, ".gitattributes"), "unsafe.bin filter=custom\n");
      await writeFile(target, "bytes\n");
    },
  ],
  [
    "oversized file",
    async (_root, target) => {
      await writeFile(target, "");
      await truncate(target, TOPIK_ASSET_LIMITS.maxAssetBytes + 1);
    },
  ],
  [
    "special file",
    async (_root, target) => {
      await execFileAsync("mkfifo", [target]);
    },
  ],
];

function guide(name: string, content: string): Guide {
  return {
    apiVersion: "v1",
    type: "Guide",
    name,
    spec: { title: name, slug: name, content: { format: "topik", value: content } },
  };
}

function wikiPage(name: string, content: string): WikiPage {
  return {
    apiVersion: "v1",
    type: "WikiPage",
    name,
    spec: { wiki: "docs", title: name, content: { format: "topik", value: content } },
  };
}

function coursePage(name: string, content: string): CoursePage {
  return {
    apiVersion: "v1",
    type: "CoursePage",
    name,
    spec: {
      module: "module",
      title: name,
      slug: name,
      order: 0,
      content: { format: "topik", value: content },
    },
  };
}

type ContentResourceFactory = (name: string, content: string) => Guide | WikiPage | CoursePage;

const CONTENT_RESOURCE_FACTORIES: readonly (readonly [string, ContentResourceFactory])[] = [
  ["Guide", guide],
  ["WikiPage", wikiPage],
  ["CoursePage", coursePage],
];

function compiledAsset(): Asset {
  const digest = "0".repeat(64);
  return {
    apiVersion: "v1",
    type: "Asset",
    name: parseGeneratedAssetName(`auto-v1-${"a".repeat(52)}`),
    spec: {
      uri: `assets/sha256/${digest}`,
      integrity: `sha256:${digest}`,
      size: 0,
      mediaType: "application/octet-stream",
    },
  };
}

describe("compilation-wide automatic Assets", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-automatic-assets-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("discovers one local Asset, rewrites content, and emits exact output facts", async () => {
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "guide.md"), "source\n");
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [guide("guide", "![Hero](hero.png)\n")],
      sourcePathsByResource: { "Guide/guide": "guide.md" },
      sourceNamespace: "automatic-fixture",
    });
    const asset = result.resources.find((resource) => resource.type === "Asset");
    const compiledGuide = result.resources.find(
      (resource): resource is Guide => resource.type === "Guide",
    );

    expect(asset).toEqual({
      apiVersion: "v1",
      type: "Asset",
      name: expect.stringMatching(/^auto-v1-[a-z2-7]{51}[aq]$/u),
      spec: {
        uri: expect.stringMatching(/^assets\/sha256\/[0-9a-f]{64}$/u),
        integrity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        size: PNG_BYTES.byteLength,
        mediaType: "image/png",
      },
    });
    expect(compiledGuide?.spec.content.value).toContain(`asset:${asset?.name}`);
    expect(result.payloads).toHaveLength(1);
  });

  test("leaves credential-free HTTPS external without synthesizing or downloading Assets", async () => {
    await writeFile(join(dir, "guide.md"), "source\n");
    const source = guide(
      "guide",
      [
        "![External image](https://example.com/image.png)",
        "[External file](https://example.com/file.pdf)",
        '{% figure src="https://example.com/light.png" darkSrc="https://example.com/dark.png" alt="External" /%}',
      ].join("\n\n"),
    );
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [source],
      sourcePathsByResource: { "Guide/guide": "guide.md" },
    });

    expect(result.resources).toEqual([source]);
    expect(result.payloads).toEqual([]);
    expect(result.semantic).toMatchObject({ assetNames: [], references: [] });
  });

  test("preserves mixed-case credential-free HTTPS across every supported form", async () => {
    const content = [
      "![Image](HtTpS://example.com/image.png)",
      "[Download](hTTps://example.com/manual.pdf)",
      "<HTTPS://example.com/autolink.pdf>",
      '{% figure src="HTtPs://example.com/light.png" darkSrc="htTPs://example.com/dark.png" alt="Theme" /%}',
    ].join("\n\n");
    const source = guide("guide", content);

    const result = await compileAssetResources({
      rootDir: dir,
      resources: [source],
      sourcePathsByResource: { "Guide/guide": "guide.md" },
    });

    expect(result.resources).toEqual([source]);
    expect((result.resources[0] as Guide).spec.content.value).toBe(content);
    expect(result.payloads).toEqual([]);
    expect(result.semantic).toMatchObject({ assetNames: [], references: [] });
  });

  test("leaves a credential-free HTTPS autolink unchanged without creating an Asset", async () => {
    await writeFile(join(dir, "guide.md"), "source\n");
    const source = guide("guide", "<https://example.com/file.pdf>\n");
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [source],
      sourcePathsByResource: { "Guide/guide": "guide.md" },
    });

    expect(result.resources).toEqual([source]);
    expect(result.payloads).toEqual([]);
    expect(result.semantic).toMatchObject({ assetNames: [], references: [] });
  });

  test("leaves an unpaired effective credential-free HTTPS image external", async () => {
    await writeFile(join(dir, "guide.md"), "source\n");
    const content =
      "![Unavailable][id] ![Hero](https://example.com/hero.png)\n\n" +
      "> [id]: https://example.com/hero.png\n";
    const source = guide("guide", content);
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [source],
      sourcePathsByResource: { "Guide/guide": "guide.md" },
    });

    expect(result.resources).toEqual([source]);
    expect(result.payloads).toEqual([]);
    expect(result.semantic).toMatchObject({ assetNames: [], references: [] });
  });

  test.each([
    "![HTTP image](http://example.com/image.png)",
    "![Mixed HTTP image](HtTp://example.com/image.png)",
    "[HTTP file](http://example.com/file.pdf)",
    "[Mixed HTTP file](hTtP://example.com/file.pdf)",
    "<http://example.com/file.pdf>",
    "<HTtp://example.com/file.pdf>",
    "<https://user:secret@example.com/file.pdf>",
    "<hTtPs://user:secret@example.com/file.pdf>",
    "<person@example.com> <http://example.com/file.pdf>",
    "![Protocol relative](//example.com/image.png)",
    '{% figure src="HtTpS://[invalid" alt="Malformed HTTPS" /%}',
    '{% figure src="https://user:secret@example.com/image.png" alt="Unsafe HTTPS" /%}',
  ])("rejects HTTP or unsafe HTTPS source reference: %s", async (content) => {
    await writeFile(join(dir, "guide.md"), "source\n");
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("guide", content)],
        sourcePathsByResource: { "Guide/guide": "guide.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE" })],
    });
  });

  test("excludes programmatic Asset declarations from the public input type and rejects injection", async () => {
    const asset = compiledAsset();
    const invalidTypedInput: CompileAssetResourcesInput = {
      rootDir: dir,
      // @ts-expect-error Asset resources are compiler output, not compile input.
      resources: [asset],
      sourcePathsByResource: {},
    };
    await expect(
      compileAssetResources(invalidTypedInput as unknown as CompileAssetResourcesInput),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_SCHEMA_INVALID" })],
    });
  });

  test.each([
    ["link with user-selected name", "[Download](asset:company-logo)"],
    ["link with malformed generated name", "[Download](asset:auto-v1-short)"],
    ["link with full generated name", `[Download](asset:${compiledAsset().name})`],
    ["image with user-selected name", "![Image](asset:company-logo)"],
    ["image with malformed generated name", "![Image](asset:auto-v1-short)"],
    ["image with full generated name", `![Image](asset:${compiledAsset().name})`],
    ["figure with user-selected name", '{% figure src="asset:company-logo" alt="Figure" /%}'],
    [
      "figure with malformed generated name",
      '{% figure src="asset:auto-v1-short" alt="Figure" /%}',
    ],
    [
      "figure with full generated name",
      `{% figure src="asset:${compiledAsset().name}" alt="Figure" /%}`,
    ],
    ["case-aliased scheme", "[Download](ASSET:company-logo)"],
    ["percent-encoded scheme delimiter", "[Download](asset%3Acompany-logo)"],
    ["percent-encoded scheme letter", "[Download](%61sset%3Acompany-logo)"],
    ["encoded scheme with malformed suffix", "[Download](asset%3Acompany%ZZ)"],
    ["entity-encoded scheme delimiter", "[Download](asset&#58;company-logo)"],
  ])("rejects reserved source Asset locator in %s", async (_name, content) => {
    await writeFile(join(dir, "guide.md"), "source\n");
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("guide", content)],
        sourcePathsByResource: { "Guide/guide": "guide.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED" })],
    });
  });

  test("preserves ordinary relative navigation without synthesizing an Asset", async () => {
    await writeFile(join(dir, "one.md"), "source\n");
    await writeFile(join(dir, "two.md"), "source\n");
    const resources = [
      guide("one", "[Next](two.md) [Absent route](missing.md)\n"),
      guide("two", "Next page\n"),
    ];
    const result = await compileAssetResources({
      rootDir: dir,
      resources,
      sourcePathsByResource: { "Guide/one": "one.md", "Guide/two": "two.md" },
    });

    expect(result.resources).toEqual(resources);
    expect(result.payloads).toEqual([]);
    expect(result.semantic.references).toEqual([]);
  });

  test.each(
    CONTENT_RESOURCE_FACTORIES.flatMap(([resourceType, createResource]) =>
      [
        ["user-selected", "asset:company-logo"],
        ["malformed-generated", "asset:auto-v1-short"],
        ["full-generated", `asset:${compiledAsset().name}`],
        ["case-aliased", "ASSET:company-logo"],
      ].map(([targetKind, target]) => [resourceType, targetKind, createResource, target] as const),
    ),
  )(
    "rejects %s card with %s reserved Asset target at the direct boundary",
    async (_resourceType, _targetKind, createResource, target) => {
      await writeFile(join(dir, "page.md"), "source\n");
      const resource = createResource("page", `{% card title="Download" href="${target}" /%}\n`);

      await expect(
        compileAssetResources({
          rootDir: dir,
          resources: [resource],
          sourcePathsByResource: { [`${resource.type}/${resource.name}`]: "page.md" },
        }),
      ).rejects.toMatchObject({
        diagnostics: [
          expect.objectContaining({
            id: "TOPIK_ASSET_REFERENCE_MALFORMED",
            location: expect.objectContaining({ path: "page.md" }),
          }),
        ],
      });
    },
  );

  test.each(CONTENT_RESOURCE_FACTORIES)(
    "preserves ordinary card navigation in %s",
    async (_resourceType, createResource) => {
      await writeFile(join(dir, "page.md"), "source\n");
      const resource = createResource("page", '{% card title="Next" href="next-page" /%}\n');
      const result = await compileAssetResources({
        rootDir: dir,
        resources: [resource],
        sourcePathsByResource: { [`${resource.type}/${resource.name}`]: "page.md" },
      });

      expect(result.resources).toEqual([resource]);
      expect(result.payloads).toEqual([]);
      expect(result.semantic.references).toEqual([]);
    },
  );

  test("keeps identity across byte edits and changes identity when the path moves", async () => {
    await writeFile(join(dir, "one.png"), PNG_BYTES);
    await writeFile(join(dir, "guide.md"), "source\n");
    const input = {
      rootDir: dir,
      resources: [guide("guide", "![One](one.png)\n")],
      sourcePathsByResource: { "Guide/guide": "guide.md" },
      sourceNamespace: "identity-fixture",
    } as const;
    const first = await compileAssetResources(input);
    const changed = Uint8Array.from(PNG_BYTES);
    changed[changed.length - 1] ^= 1;
    await writeFile(join(dir, "one.png"), changed);
    const edited = await compileAssetResources(input);
    await writeFile(join(dir, "moved.png"), changed);
    const moved = await compileAssetResources({
      ...input,
      resources: [guide("guide", "![One](moved.png)\n")],
    });
    const name = first.resources.find((resource) => resource.type === "Asset")?.name;

    expect(edited.resources.find((resource) => resource.type === "Asset")?.name).toBe(name);
    expect(edited.payloads[0].integrity).not.toBe(first.payloads[0].integrity);
    expect(moved.resources.find((resource) => resource.type === "Asset")?.name).not.toBe(name);
  });

  test("isolates namespaces and equal-byte paths while deduplicating the payload", async () => {
    await writeFile(join(dir, "a.png"), PNG_BYTES);
    await writeFile(join(dir, "b.png"), PNG_BYTES);
    await writeFile(join(dir, "guide.md"), "source\n");
    const resources = [guide("guide", "![A](a.png) ![B](b.png)\n")];
    const first = await compileAssetResources({
      rootDir: dir,
      resources,
      sourcePathsByResource: { "Guide/guide": "guide.md" },
      sourceNamespace: "source-one",
    });
    const second = await compileAssetResources({
      rootDir: dir,
      resources,
      sourcePathsByResource: { "Guide/guide": "guide.md" },
      sourceNamespace: "source-two",
    });
    const firstNames = first.resources
      .filter((resource) => resource.type === "Asset")
      .map((resource) => resource.name);
    const secondNames = second.resources
      .filter((resource) => resource.type === "Asset")
      .map((resource) => resource.name);

    expect(new Set(firstNames).size).toBe(2);
    expect(first.payloads).toHaveLength(1);
    expect(first.payloads[0].assetNames).toEqual(firstNames.sort());
    expect(secondNames).not.toEqual(firstNames);
  });

  test("shares one Asset across repeated occurrences and multiple Guides", async () => {
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    await writeFile(join(dir, "one.md"), "source\n");
    await writeFile(join(dir, "two.md"), "source\n");
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [
        guide("one", "![Shared](shared.png) ![Again](shared.png)\n"),
        guide("two", "![Shared](shared.png)\n"),
      ],
      sourcePathsByResource: { "Guide/one": "one.md", "Guide/two": "two.md" },
      sourceNamespace: "multiple-guides",
    });

    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
    expect(result.semantic.references).toHaveLength(3);
    expect(result.payloads).toHaveLength(1);
  });

  test("compiles Assets from every page in a multipage Wiki into one set", async () => {
    await mkdir(join(dir, "pages"));
    await writeFile(join(dir, "pages", "one.png"), PNG_BYTES);
    await writeFile(join(dir, "pages", "two.png"), PNG_BYTES);
    await writeFile(join(dir, "pages", "one.md"), "source\n");
    await writeFile(join(dir, "pages", "two.md"), "source\n");
    const wiki: Wiki = { apiVersion: "v1", type: "Wiki", name: "docs", spec: { title: "Docs" } };
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [
        wiki,
        wikiPage("page-one", "![One](one.png)\n"),
        wikiPage("page-two", "![Two](two.png)\n"),
      ],
      sourcePathsByResource: {
        "WikiPage/page-one": "pages/one.md",
        "WikiPage/page-two": "pages/two.md",
      },
      sourceNamespace: "multipage-wiki",
    });

    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(2);
    expect(result.semantic.references).toHaveLength(2);
    expect(result.payloads).toHaveLength(1);
  });

  test("compiles a mixed Guide, Wiki, and Course against one Asset set", async () => {
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    for (const path of ["guide.md", "wiki.md", "course.md"]) {
      await writeFile(join(dir, path), "source\n");
    }
    const wiki: Wiki = { apiVersion: "v1", type: "Wiki", name: "docs", spec: { title: "Docs" } };
    const course: Course = {
      apiVersion: "v1",
      type: "Course",
      name: "course",
      spec: { title: "Course", slug: "course" },
    };
    const module: CourseModule = {
      apiVersion: "v1",
      type: "CourseModule",
      name: "module",
      spec: { course: "course", title: "Module", slug: "module", order: 0 },
    };
    const page: CoursePage = {
      apiVersion: "v1",
      type: "CoursePage",
      name: "course-page",
      spec: {
        module: "module",
        title: "Page",
        slug: "page",
        order: 0,
        content: { format: "topik", value: "![Shared](shared.png)\n" },
      },
    };
    const resources: SourceResource[] = [
      guide("guide", "![Shared](shared.png)\n"),
      wiki,
      wikiPage("wiki-page", "![Shared](shared.png)\n"),
      course,
      module,
      page,
    ];
    const result = await compileAssetResources({
      rootDir: dir,
      resources,
      sourcePathsByResource: {
        "Guide/guide": "guide.md",
        "WikiPage/wiki-page": "wiki.md",
        "CoursePage/course-page": "course.md",
      },
      sourceNamespace: "mixed-content",
    });

    expect(result.resources.map((resource) => resource.type)).toEqual([
      "Asset",
      "Course",
      "CourseModule",
      "CoursePage",
      "Guide",
      "Wiki",
      "WikiPage",
    ]);
    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
    expect(result.semantic.references).toHaveLength(3);
    expect(result.payloads).toHaveLength(1);
  });

  test("automatically proves local downloads and leaves page navigation and HTTPS external", async () => {
    await writeFile(join(dir, "manual.bin"), "manual bytes\n");
    await writeFile(join(dir, "one.md"), "source\n");
    await writeFile(join(dir, "two.md"), "source\n");
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [
        guide(
          "one",
          "[Manual](manual.bin) [Next](two.md) [External](https://example.com/manual.bin)\n",
        ),
        guide("two", "No Assets\n"),
      ],
      sourcePathsByResource: { "Guide/one": "one.md", "Guide/two": "two.md" },
      sourceNamespace: "downloads",
    });
    const compiledGuide = result.resources.find(
      (resource): resource is Guide => resource.type === "Guide" && resource.name === "one",
    );

    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
    expect(compiledGuide?.spec.content.value).toContain("[Manual](asset:auto-v1-");
    expect(compiledGuide?.spec.content.value).toContain("[Next](two.md)");
    expect(compiledGuide?.spec.content.value).toContain("https://example.com/manual.bin");
  });

  test("discovers and rewrites downloads with accessible code, mixed, reference, and image labels", async () => {
    await writeFile(join(dir, "manual.bin"), "manual bytes\n");
    await writeFile(join(dir, "icon.png"), PNG_BYTES);
    await writeFile(join(dir, "guide.md"), "source\n");
    const content = [
      "[`Manual`](manual.bin)",
      "[**API `Manual`**](manual.bin)",
      "[Reference `Manual`][manual]",
      "[![Manual icon](icon.png)](manual.bin)",
      "",
      "[manual]: manual.bin",
    ].join("\n");

    const result = await compileAssetResources({
      rootDir: dir,
      resources: [guide("guide", content)],
      sourcePathsByResource: { "Guide/guide": "guide.md" },
      sourceNamespace: "accessible-download-labels",
    });
    const compiledGuide = result.resources.find(
      (resource): resource is Guide => resource.type === "Guide",
    );

    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(2);
    expect(
      result.semantic.references.filter((reference) => reference.slot === "link.href"),
    ).toHaveLength(4);
    expect(
      compiledGuide?.spec.content.value.match(/\]\(asset:auto-v1-[a-z2-7]{51}[aq]/gu),
    ).toHaveLength(5);
  });

  test("rejects a download labeled only by a decorative nested image", async () => {
    await writeFile(join(dir, "manual.bin"), "manual bytes\n");
    await writeFile(join(dir, "icon.png"), PNG_BYTES);
    await writeFile(join(dir, "guide.md"), "source\n");

    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("guide", "[![](icon.png)](manual.bin)")],
        sourcePathsByResource: { "Guide/guide": "guide.md" },
        sourceNamespace: "empty-download-label",
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_ACCESSIBILITY_INVALID" })],
    });
  });

  test.each(['"title (detail)"', "'title (detail)'", "(title detail)"])(
    "discovers and rewrites image and download references with inline title form %s",
    async (title) => {
      await writeFile(join(dir, "hero.png"), PNG_BYTES);
      await writeFile(join(dir, "manual.bin"), "manual bytes\n");
      await writeFile(join(dir, "guide.md"), "source\n");
      const content = `![Hero](hero.png ${title})\n\n[Manual](manual.bin ${title})\n`;
      expect(
        extractTopikAssetOccurrences(content, { includeGenericLinkCandidates: true }),
      ).toMatchObject([
        { slot: "image.src", reference: "hero.png", kind: "local" },
        { slot: "link.href", reference: "manual.bin", kind: "local" },
      ]);
      const result = await compileAssetResources({
        rootDir: dir,
        resources: [guide("guide", content)],
        sourcePathsByResource: { "Guide/guide": "guide.md" },
        sourceNamespace: "inline-titles",
      });
      const compiledGuide = result.resources.find(
        (resource): resource is Guide => resource.type === "Guide",
      );

      expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(2);
      expect(result.semantic.references.map((reference) => reference.slot).sort()).toEqual([
        "image.src",
        "link.href",
      ]);
      expect(compiledGuide?.spec.content.value).toMatch(
        /!\[Hero\]\(asset:auto-v1-[a-z2-7]{51}[aq] "title(?: \(detail\)| detail)"\)/u,
      );
      expect(compiledGuide?.spec.content.value).toMatch(
        /\[Manual\]\(asset:auto-v1-[a-z2-7]{51}[aq] "title(?: \(detail\)| detail)"\)/u,
      );
    },
  );

  test("preserves every supported decoded title form through automatic rewrite and closure", async () => {
    const titleCases = [
      ['"title \\"double\\" (v1)"', 'title "double" (v1)'],
      [`'title "single" (v1)'`, 'title "single" (v1)'],
      [`(title "parenthesized" v1)`, 'title "parenthesized" v1'],
      [`'title \\'escaped-single\\' "quote"'`, `title 'escaped-single' "quote"`],
      [`(title \\) escaped-parenthesized "quote")`, `title ) escaped-parenthesized "quote"`],
      ['"title &quot;entity&quot; (v1)"', 'title "entity" (v1)'],
      ['"title\n&quot;multiline&quot; (v1)"', 'title\n"multiline" (v1)'],
      ['"title \\\\ path"', "title \\ path"],
      ['"title &amp;quot; literal"', "title &quot; literal"],
    ] as const;
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "manual.bin"), "manual bytes\n");
    await writeFile(join(dir, "guide.md"), "source\n");
    const content = titleCases
      .flatMap(([titleSource], index) => [
        `![Hero ${index}](hero.png ${titleSource})`,
        `[Manual ${index}](manual.bin ${titleSource})`,
      ])
      .join("\n\n");

    const result = await compileAssetResources({
      rootDir: dir,
      resources: [guide("guide", content)],
      sourcePathsByResource: { "Guide/guide": "guide.md" },
      sourceNamespace: "decoded-inline-titles",
    });
    const compiledGuide = result.resources.find(
      (resource): resource is Guide => resource.type === "Guide",
    );
    const rewritten = compiledGuide?.spec.content.value ?? "";
    const occurrences = extractTopikAssetOccurrences(rewritten, {
      includeGenericLinkCandidates: true,
    });

    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(2);
    expect(result.semantic.references).toHaveLength(titleCases.length * 2);
    expect(occurrences.map((occurrence) => occurrence.semantics.title)).toEqual(
      titleCases.flatMap(([, title]) => [title, title]),
    );
    expect(occurrences.every((occurrence) => occurrence.kind === "asset")).toBe(true);
  });

  test.each(CONTENT_RESOURCE_FACTORIES)(
    "preserves existing directory navigation across %s content with and without trailing slashes",
    async (type, createResource) => {
      await mkdir(join(dir, "packages"));
      await mkdir(join(dir, "docs", "routes"), { recursive: true });
      const content = [
        "[Packages](../packages)",
        "[Packages slash](../packages/)",
        "[Nested routes](routes)",
        "[Nested routes slash](routes/)",
      ].join("\n\n");
      const resource = createResource("page", content);

      const result = await compileAssetResources({
        rootDir: dir,
        resources: [resource],
        sourcePathsByResource: { [`${type}/page`]: "docs/page.md" },
      });

      expect(result.resources).toEqual([resource]);
      expect(result.payloads).toEqual([]);
      expect(result.semantic.references).toEqual([]);
    },
  );

  test.each(UNSAFE_GENERIC_LINK_CASES)(
    "rejects an existing unsafe %s generic-link target",
    async (_kind, setup) => {
      const target = join(dir, "unsafe.bin");
      await setup(dir, target);
      await writeFile(join(dir, "guide.md"), "source\n");

      await expect(
        compileAssetResources({
          rootDir: dir,
          resources: [guide("guide", "[Download](unsafe.bin)\n")],
          sourcePathsByResource: { "Guide/guide": "guide.md" },
          sourceNamespace: "unsafe-generic-link",
        }),
      ).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" })],
      });
    },
  );

  test.each(["unsafe\\.bin", "unsafe&#46;bin"])(
    "rejects an unsafe existing target behind effective generic-link destination %s",
    async (reference) => {
      await writeFile(join(dir, "symlink-source.bin"), "bytes\n");
      await symlink("symlink-source.bin", join(dir, "unsafe.bin"));
      await writeFile(join(dir, "guide.md"), "source\n");

      await expect(
        compileAssetResources({
          rootDir: dir,
          resources: [guide("guide", `[Download](${reference})\n`)],
          sourcePathsByResource: { "Guide/guide": "guide.md" },
          sourceNamespace: "effective-unsafe-generic-link",
        }),
      ).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" })],
      });
    },
  );

  test.each(["manual\\.bin", "manual&#46;bin"])(
    "rejects a noncanonical proven download destination %s",
    async (reference) => {
      await writeFile(join(dir, "manual.bin"), "bytes\n");
      await writeFile(join(dir, "guide.md"), "source\n");

      await expect(
        compileAssetResources({
          rootDir: dir,
          resources: [guide("guide", `[Download](${reference})\n`)],
          sourcePathsByResource: { "Guide/guide": "guide.md" },
          sourceNamespace: "noncanonical-download",
        }),
      ).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED" })],
      });
    },
  );

  test("surfaces a generic-link target changed during its deterministic read", async () => {
    const target = join(dir, "unsafe.bin");
    await writeFile(target, "original bytes\n");
    await writeFile(join(dir, "guide.md"), "source\n");
    const original = await lstat(target);

    await expect(
      compileAssetResourcesWithReadHookForTest(
        {
          rootDir: dir,
          resources: [guide("guide", "[Download](unsafe.bin)\n")],
          sourcePathsByResource: { "Guide/guide": "guide.md" },
          sourceNamespace: "changed-generic-link",
        },
        async () => {
          await writeFile(target, "modified bytes\n");
          await utimes(target, original.atime, original.mtime);
        },
      ),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" })],
    });
  });

  test("rejects active bytes and media that is incompatible with its content role", async () => {
    await writeFile(join(dir, "guide.md"), "source\n");
    await writeFile(join(dir, "active.html"), "<!doctype html><title>Unsafe</title>\n");
    await writeFile(join(dir, "manual.pdf"), "%PDF-1.7\n");
    const input = {
      rootDir: dir,
      sourcePathsByResource: { "Guide/guide": "guide.md" },
      sourceNamespace: "media-failures",
    } as const;

    await expect(
      compileAssetResources({
        ...input,
        resources: [guide("guide", "![Unsafe](active.html)\n")],
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED" })],
    });
    await expect(
      compileAssetResources({
        ...input,
        resources: [guide("guide", "![Manual](manual.pdf)\n")],
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_MEDIA_TYPE_MISMATCH" })],
    });
  });

  test.each([
    ["image", "![Nested](vendor/module/hero.png)"],
    ["proven download", "[Nested](vendor/module/hero.png)"],
  ])("rejects a real checked-out Git submodule %s target", async (_kind, content) => {
    if (process.platform !== "linux") return;
    const origin = join(dir, "origin");
    const root = join(dir, "root");
    await createGitRepository(origin);
    await writeFile(join(origin, "hero.png"), PNG_BYTES);
    await git(origin, "add", "hero.png");
    await git(origin, "commit", "-qm", "fixture");
    await createGitRepository(root);
    await git(
      root,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      origin,
      "vendor/module",
    );
    await writeFile(join(root, "guide.md"), "source\n");

    await expect(
      compileAssetResources({
        rootDir: root,
        resources: [guide("guide", content)],
        sourcePathsByResource: { "Guide/guide": "guide.md" },
        sourceNamespace: "real-submodule",
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" })],
    });
  });

  test("fails visibly on missing bytes, missing namespaces, protected inputs, and collisions", async () => {
    await writeFile(join(dir, "a.png"), PNG_BYTES);
    await writeFile(join(dir, "b.png"), PNG_BYTES);
    await writeFile(join(dir, "guide.md"), "source\n");
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("guide", "![Missing](missing.png)\n")],
        sourcePathsByResource: { "Guide/guide": "guide.md" },
        sourceNamespace: "failures",
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_FILE_MISSING" })],
    });
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("guide", "![A](a.png)\n")],
        sourcePathsByResource: { "Guide/guide": "guide.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_SOURCE_NAMESPACE_REQUIRED" })],
    });
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("guide", "![Input](config.yaml)\n")],
        sourcePathsByResource: { "Guide/guide": "guide.md" },
        protectedSourcePaths: ["config.yaml"],
        sourceNamespace: "failures",
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_AMBIGUOUS" })],
    });
    const paths = new Map<GeneratedAssetName, string>();
    const collidingName = parseGeneratedAssetName(`auto-v1-${"a".repeat(52)}`);
    registerGeneratedAssetPath(paths, collidingName, "a.png");
    expect(() => registerGeneratedAssetPath(paths, collidingName, "b.png")).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_NAME_COLLISION" })],
      }),
    );
  });

  test("preserves typed, sanitized validation diagnostics", async () => {
    const future = {
      apiVersion: "future-secret-version",
      type: "Guide",
      name: "secret-name",
      spec: {},
    } as unknown as SourceResource;
    let diagnostics: readonly unknown[] = [];
    try {
      await compileAssetResources({
        rootDir: dir,
        resources: [future],
        sourcePathsByResource: {},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AssetCompilationError);
      diagnostics = (error as AssetCompilationError).diagnostics;
    }
    expect(diagnostics).toEqual([
      expect.objectContaining({
        id: "TOPIK_ASSET_UNSUPPORTED_VERSION",
        descriptorVersion: "Guide/unsupported",
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret|future/i);
  });
});

async function createGitRepository(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "Fixture");
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });
}
