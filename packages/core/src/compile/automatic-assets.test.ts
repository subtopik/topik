import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { Asset, Course, CourseModule, CoursePage, Guide, Wiki, WikiPage } from "@topik/schema";
import type { SourceResource } from "../resource";
import {
  AssetCompilationError,
  compileAssetResources,
  registerGeneratedAssetPath,
  type CompileAssetResourcesInput,
} from "./assets";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

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

function compiledAsset(): Asset {
  const digest = "0".repeat(64);
  return {
    apiVersion: "v1",
    type: "Asset",
    name: `auto-v1-${"a".repeat(52)}`,
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
      name: expect.stringMatching(/^auto-v1-[a-z2-7]{52}$/u),
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

  test.each([
    "![HTTP image](http://example.com/image.png)",
    "[HTTP file](http://example.com/file.pdf)",
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

  test("rejects source Asset references even when the generated name is well formed", async () => {
    await writeFile(join(dir, "guide.md"), "source\n");
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("guide", `![Hero](asset:${compiledAsset().name})\n`)],
        sourcePathsByResource: { "Guide/guide": "guide.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED" })],
    });
  });

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
    const paths = new Map<`auto-v1-${string}`, string>();
    const collidingName = `auto-v1-${"a".repeat(52)}` as const;
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
