import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { extractTopikAssetOccurrences } from "@topik/content-schema";
import type { Course, CourseModule, CoursePage, Guide, Wiki, WikiPage } from "@topik/schema";
import {
  createTopikMaterializationRecord,
  digestTopikMaterializationRecord,
  parseAssetManifest,
  serializeTopikJson,
  validateResources,
  type TopikMaterializationFileInput,
} from "../index";
import { compileGuides } from "./guide";
import {
  compilePortableResourceArtifacts,
  PortableAssetCompilationError,
  TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
} from "./assets";
import { compileWiki } from "./wiki";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function entropy() {
  let counter = 0;
  return (size: number) => {
    const bytes = new Uint8Array(size);
    bytes[bytes.length - 1] = counter++;
    return bytes;
  };
}

describe("direct portable artifact compilation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-portable-compile-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("compiles multiple guides with zero, duplicate, multiple, and shared assets", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
    await writeFile(join(dir, "empty.md"), "# Empty\n");
    await writeFile(join(dir, "one.md"), "# One\n\n![Shared](shared.png)\n");
    await writeFile(
      join(dir, "many.md"),
      "# Many\n\n![First](shared.png)\n\n![Again](shared.png)\n\n![Other](other.png)\n",
    );
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    const other = Uint8Array.from(PNG_BYTES);
    other[other.length - 1] ^= 1;
    await writeFile(join(dir, "other.png"), other);

    const first = await compileGuides({ dir, assets: { randomBytes: entropy() } });
    expect(first.resources).toHaveLength(3);
    expect(first.artifacts.map((artifact) => artifact.resourceRoot)).toEqual([
      "Guide/docs-empty",
      "Guide/docs-many",
      "Guide/docs-one",
    ]);
    expect(first.artifacts.map((artifact) => Object.keys(artifact.manifest.assets).length)).toEqual(
      [0, 2, 1],
    );
    const many = first.artifacts[1];
    expect(many.snapshot.occurrences).toHaveLength(3);
    expect(new Set(many.snapshot.occurrences.map((occurrence) => occurrence.assetKey)).size).toBe(
      2,
    );

    const sharedEntries = first.artifacts
      .flatMap((artifact) => Object.entries(artifact.manifest.assets))
      .filter(([, entry]) => entry.path === "shared.png");
    expect(sharedEntries).toHaveLength(2);
    expect(new Set(sharedEntries.map(([key]) => key)).size).toBe(2);
    expect(first.resources.every((resource) => !("assets" in resource.spec))).toBe(true);

    const retry = await compileGuides({
      dir,
      assets: { keyState: first.assetKeyState, randomBytes: entropy() },
    });
    expect(retry.artifacts.map((artifact) => artifact.manifestBytes)).toEqual(
      first.artifacts.map((artifact) => artifact.manifestBytes),
    );
  });

  test("compiles a multi-page wiki without giving the Wiki container an artifact", async () => {
    await writeFile(
      join(dir, "wiki.yaml"),
      "id: docs\ntitle: Docs\nnavigation:\n  - empty\n  - one\n  - many\n",
    );
    await writeFile(join(dir, "empty.md"), "# Empty\n");
    await writeFile(join(dir, "one.md"), "# One\n\n![Shared](shared.png)\n");
    await writeFile(
      join(dir, "many.md"),
      "# Many\n\n![Shared](shared.png)\n\n![A](a.png)\n\n![B](b.png)\n",
    );
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    await writeFile(join(dir, "a.png"), PNG_BYTES);
    await writeFile(join(dir, "b.png"), PNG_BYTES);

    const result = await compileWiki({ dir, assets: { randomBytes: entropy() } });
    expect(result.resources.map((resource) => resource.type)).toEqual([
      "WikiPage",
      "WikiPage",
      "WikiPage",
      "Wiki",
    ]);
    expect(validateResources(result.resources)).toMatchObject({ valid: true });
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts.map((artifact) => artifact.resourceRoot)).not.toContain("Wiki/docs");
    const counts = new Map(
      result.artifacts.map((artifact) => [
        artifact.resource.spec.title,
        Object.keys(artifact.manifest.assets).length,
      ]),
    );
    expect(counts).toEqual(
      new Map<string, number>([
        ["Empty", 0],
        ["Many", 3],
        ["One", 1],
      ]),
    );
    const shared = result.artifacts.flatMap((artifact) =>
      Object.entries(artifact.manifest.assets).filter(([, entry]) => entry.path === "shared.png"),
    );
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map(([key]) => key)).size).toBe(2);
  });

  test("proves plain downloads while preserving resource links and rejecting explicit ambiguity", async () => {
    const content = "[Download](manual.bin)\n\n[Chapter](chapter.md)\n";
    const candidates = extractTopikAssetOccurrences(content, {
      includeGenericLinkCandidates: true,
    });
    const chapter = candidates.find((occurrence) => occurrence.reference === "chapter.md");
    await writeFile(join(dir, "guide.md"), content);
    await writeFile(join(dir, "chapter.md"), "# Chapter\n");
    await writeFile(join(dir, "manual.bin"), "offline bytes");
    const resource = guideResource("download", content);

    const compiled = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [resource, guideResource("chapter", "# Chapter\n")],
      sourcePathsByResource: {
        "Guide/download": "guide.md",
        "Guide/chapter": "chapter.md",
      },
      randomBytes: entropy(),
    });
    expect(Object.values(compiled.artifacts[1].manifest.assets)).toMatchObject([
      { path: "manual.bin", mediaType: "application/octet-stream" },
    ]);
    expect(compiled.artifacts[1].snapshot.occurrences).toHaveLength(1);
    expect(compiled.artifacts[1].resource.spec.content.value).toContain("[Chapter](chapter.md)");

    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [resource, guideResource("chapter", "# Chapter\n")],
        sourcePathsByResource: {
          "Guide/download": "guide.md",
          "Guide/chapter": "chapter.md",
        },
        downloadableLinkPositionsByResource: {
          "Guide/download": [chapter?.position ?? "missing"],
        },
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_AMBIGUOUS" }),
      ]),
    });
  });

  test.each([
    ["comment-prefixed HTML", "<!-- generated -->\n<html><body>x</body></html>"],
    ["padded HTML", `${" ".repeat(4096)}<html><body>x</body></html>`],
    ["XML-prefixed HTML", '<?xml version="1.0"?><html><body>x</body></html>'],
    ["HTML fragment", "<div>fragment</div>"],
    ["script fragment", "<script>alert(1)</script>"],
    ["active body fragment", '<body onload="alert(1)">x</body>'],
    ["SVG", '<svg xmlns="http://www.w3.org/2000/svg"><script /></svg>'],
    ["padded SVG", `${" ".repeat(4096)}<svg xmlns="http://www.w3.org/2000/svg" />`],
    ["SVG doctype", '<!DOCTYPE svg PUBLIC "x"><svg />'],
    [
      "XML/comment-prefixed SVG",
      '<?xml version="1.0"?><!-- generated --><svg xmlns="http://www.w3.org/2000/svg" />',
    ],
    ["inspection-exhausting padding", `${" ".repeat(64 * 1024)}<html><body>x</body></html>`],
    ["executable signature", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1])],
  ])("rejects recognizable active %s disguised as an opaque download", async (_name, source) => {
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
    await writeFile(join(dir, "active.bin"), bytes);
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [guideResource("active", "[Download](active.bin)\n")],
        sourcePathsByResource: { "Guide/active": "guide.md" },
        randomBytes: entropy(),
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          id: "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED",
          severity: "error",
        }),
      ]),
    });
  });

  test("compiles a mixed resource set and assigns artifacts only to content-bearing resources", async () => {
    await mkdir(join(dir, "pages"));
    await writeFile(join(dir, "guide.md"), "![Guide](shared.png)\n");
    await writeFile(join(dir, "pages", "first.md"), "![First](shared.png)\n");
    await writeFile(join(dir, "pages", "second.md"), "# Second\n");
    await writeFile(join(dir, "course.md"), "![Course](course.png)\n");
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    await writeFile(join(dir, "course.png"), PNG_BYTES);

    const guide = guideResource("guide", "![Guide](shared.png)\n");
    const wiki: Wiki = { apiVersion: "v1", type: "Wiki", name: "wiki", spec: { title: "Wiki" } };
    const first = wikiPageResource("first", "![First](shared.png)\n");
    const second = wikiPageResource("second", "# Second\n");
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
        title: "Course page",
        slug: "page",
        order: 0,
        content: { format: "topik", value: "![Course](course.png)\n" },
      },
    };
    const resources = [guide, wiki, first, second, course, module, page];
    const compiled = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources,
      sourcePathsByResource: {
        "Guide/guide": "guide.md",
        "WikiPage/first": "pages/first.md",
        "WikiPage/second": "pages/second.md",
        "CoursePage/course-page": "course.md",
      },
      randomBytes: entropy(),
    });

    expect(validateResources(compiled.resources)).toMatchObject({ valid: true });
    expect(compiled.artifacts.map((artifact) => artifact.resourceRoot)).toEqual([
      "CoursePage/course-page",
      "Guide/guide",
      "WikiPage/first",
      "WikiPage/second",
    ]);
    expect(compiled.resources.map((resource) => resource.type)).toEqual(
      resources.map((resource) => resource.type),
    );
    expect(compiled.artifacts.map((artifact) => artifact.resource.type)).not.toContain("Wiki");
    expect(compiled.artifacts.map((artifact) => artifact.resource.type)).not.toContain("Course");
    expect(compiled.artifacts.map((artifact) => artifact.resource.type)).not.toContain(
      "CourseModule",
    );
  });

  test("fails closed for missing, unsafe, executable, colliding, and ambiguous inputs", async () => {
    const missing = guideResource("missing", "![Missing](missing.png)\n");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [missing],
        sourcePathsByResource: { "Guide/missing": "missing.md" },
        randomBytes: entropy(),
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_FILE_MISSING" }),
      ]),
    });

    const unsafe = guideResource("unsafe", "![Unsafe](http://example.com/a.png)\n");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [unsafe],
        sourcePathsByResource: { "Guide/unsafe": "unsafe.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE" }),
      ]),
    });

    await writeFile(join(dir, "executable.png"), PNG_BYTES);
    await chmod(join(dir, "executable.png"), 0o755);
    const executable = guideResource("executable", "![Executable](executable.png)\n");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [executable],
        sourcePathsByResource: { "Guide/executable": "executable.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }),
      ]),
    });

    await writeFile(join(dir, "real.png"), PNG_BYTES);
    await symlink("real.png", join(dir, "linked.png"));
    const linked = guideResource("linked", "![Linked](linked.png)\n");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [linked],
        sourcePathsByResource: { "Guide/linked": "linked.md" },
      }),
    ).rejects.toBeInstanceOf(PortableAssetCompilationError);

    const collision = guideResource(
      "collision",
      "![One](Stra%C3%9Fe.png)\n\n![Two](STRASSE.png)\n",
    );
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [collision],
        sourcePathsByResource: { "Guide/collision": "collision.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_COLLISION" }),
      ]),
    });

    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [guideResource("same", "# One\n"), guideResource("same", "# Two\n")],
        sourcePathsByResource: { "Guide/same": "same.md" },
      }),
    ).rejects.toThrow(/repeats a resource identity/u);
  });

  test("proves exact inventory completeness, binding, modes, determinism, and byte identity", async () => {
    await writeFile(join(dir, "guide.md"), "![Hero](hero.png)\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    const compiled = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("exact", "![Hero](hero.png)\n")],
      sourcePathsByResource: { "Guide/exact": "guide.md" },
      randomBytes: entropy(),
    });
    const artifact = compiled.artifacts[0];
    const descriptors = artifact.materialization.descriptors;
    const exact = (inventory: readonly TopikMaterializationFileInput[]) =>
      createTopikMaterializationRecord(descriptors, inventory, { contentPath: "content.topik" });

    for (const missing of ["hero.png", "resource.json", "content.topik", ".topik/assets.json"]) {
      expect(() => exact(artifact.inventory.filter((file) => file.path !== missing))).toThrow(
        /missing|complete/u,
      );
    }
    expect(() =>
      exact([
        ...artifact.inventory,
        { path: "extra.bin", type: "regular", mode: "100644", bytes: new Uint8Array([1]) },
      ]),
    ).toThrow(/complete/u);
    const resourceIndex = artifact.inventory.findIndex((file) => file.path === "resource.json");
    const wrongBinding = artifact.inventory.map((file, index) =>
      index === resourceIndex
        ? {
            ...file,
            bytes: new TextEncoder().encode(
              serializeTopikJson({ ...artifact.resource, name: "different" }),
            ),
          }
        : file,
    );
    expect(() => exact(wrongBinding)).toThrow(/binding/u);
    expect(() =>
      exact(
        artifact.inventory.map((file) =>
          file.path === "content.topik"
            ? { ...file, bytes: new TextEncoder().encode("changed") }
            : file,
        ),
      ),
    ).toThrow(/content/u);
    expect(() =>
      exact(
        artifact.inventory.map((file) =>
          file.path === "hero.png" ? { ...file, mode: "100755" as never } : file,
        ),
      ),
    ).toThrow(/mode/u);
    expect(() =>
      exact(
        artifact.inventory.map((file) =>
          file.path === "hero.png" ? { ...file, type: "symlink" as never } : file,
        ),
      ),
    ).toThrow(/type/u);

    const reversed = exact([...artifact.inventory].reverse());
    expect(digestTopikMaterializationRecord(reversed)).toBe(
      digestTopikMaterializationRecord(artifact.materialization),
    );
    const modeChanged = exact(
      artifact.inventory.map((file) => ({ ...file, mode: "0644" as const })),
    );
    expect(digestTopikMaterializationRecord(modeChanged)).not.toBe(
      digestTopikMaterializationRecord(artifact.materialization),
    );

    const changedContent = "# Changed\n";
    const changedResource = {
      ...artifact.resource,
      spec: {
        ...artifact.resource.spec,
        content: { ...artifact.resource.spec.content, value: changedContent },
      },
    };
    const contentChanged = exact(
      artifact.inventory.map((file) => {
        if (file.path === "resource.json") {
          return {
            ...file,
            bytes: new TextEncoder().encode(serializeTopikJson(changedResource)),
          };
        }
        return file.path === "content.topik"
          ? { ...file, bytes: new TextEncoder().encode(changedContent) }
          : file;
      }),
    );
    expect(digestTopikMaterializationRecord(contentChanged)).not.toBe(
      digestTopikMaterializationRecord(artifact.materialization),
    );

    const changedAssetBytes = Uint8Array.from(PNG_BYTES);
    changedAssetBytes[changedAssetBytes.length - 1] ^= 1;
    await writeFile(join(dir, "hero.png"), changedAssetBytes);
    const changedAsset = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("exact", "![Hero](hero.png)\n")],
      sourcePathsByResource: { "Guide/exact": "guide.md" },
      keyState: compiled.keyState,
      randomBytes: entropy(),
    });
    expect(digestTopikMaterializationRecord(changedAsset.artifacts[0].materialization)).not.toBe(
      digestTopikMaterializationRecord(artifact.materialization),
    );

    const parsed = parseAssetManifest(artifact.manifestBytes);
    expect(parsed).toMatchObject({ ok: true });
    const sidecar = artifact.inventory.find((file) => file.path === ".topik/assets.json");
    expect(sidecar?.bytes).toEqual(artifact.manifestBytes);
  });

  test("scopes live and retired key history independently per resource", async () => {
    const key = "ast_00000000000000000000000000";
    await writeFile(join(dir, "a.png"), PNG_BYTES);
    await writeFile(join(dir, "b.png"), PNG_BYTES);
    const scoped = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("a", "![A](a.png)\n"), guideResource("b", "![B](b.png)\n")],
      sourcePathsByResource: { "Guide/a": "a.md", "Guide/b": "b.md" },
      keyState: {
        version: TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
        keysByResource: { "Guide/a": { "a.png": key }, "Guide/b": { "b.png": key } },
        retiredKeysByResource: { "Guide/a": [], "Guide/b": [] },
      },
    });
    expect(scoped.artifacts.map((artifact) => Object.keys(artifact.manifest.assets))).toEqual([
      [key],
      [key],
    ]);

    const deleted = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("a", "# Removed\n")],
      sourcePathsByResource: { "Guide/a": "a.md" },
      keyState: scoped.keyState,
    });
    expect(deleted.keyState.keysByResource["Guide/a"]).toEqual({});
    expect(deleted.keyState.retiredKeysByResource["Guide/a"]).toEqual([key]);

    const readded = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("a", "![A](a.png)\n")],
      sourcePathsByResource: { "Guide/a": "a.md" },
      keyState: deleted.keyState,
      randomBytes: entropy(),
    });
    expect(Object.keys(readded.artifacts[0].manifest.assets)).not.toContain(key);
    expect(readded.keyState.retiredKeysByResource["Guide/a"]).toContain(key);
  });

  test("accepts prototype-named canonical asset paths and retries them stably", async () => {
    await writeFile(join(dir, "__proto__"), PNG_BYTES);
    const first = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("prototype", "![Asset](__proto__)\n")],
      sourcePathsByResource: { "Guide/prototype": "guide.md" },
      randomBytes: entropy(),
    });
    expect(Object.values(first.artifacts[0].manifest.assets)).toMatchObject([
      { path: "__proto__" },
    ]);
    const retry = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("prototype", "![Asset](__proto__)\n")],
      sourcePathsByResource: { "Guide/prototype": "guide.md" },
      keyState: first.keyState,
      randomBytes: entropy(),
    });
    expect(retry.artifacts[0].manifestBytes).toEqual(first.artifacts[0].manifestBytes);
  });

  test.each([
    ["assets%2Fhero.png", "TOPIK_ASSET_PATH_INVALID"],
    ["assets%2fhero.png", "TOPIK_ASSET_PATH_INVALID"],
    ["%2E%2E/hero.png", "TOPIK_ASSET_PATH_INVALID"],
    ["é.png", "TOPIK_ASSET_PATH_INVALID"],
    ["./hero.png", "TOPIK_ASSET_PATH_INVALID"],
    ["../hero.png", "TOPIK_ASSET_PATH_INVALID"],
    ["/hero.png", "TOPIK_ASSET_PATH_INVALID"],
    ["file:///hero.png", "TOPIK_EXTERNAL_REFERENCE_UNSAFE"],
  ])(
    "rejects noncanonical local asset reference %s with typed diagnostics",
    async (reference, id) => {
      await mkdir(join(dir, "assets"), { recursive: true });
      await writeFile(join(dir, "hero.png"), PNG_BYTES);
      await writeFile(join(dir, "assets", "hero.png"), PNG_BYTES);
      await writeFile(join(dir, "é.png"), PNG_BYTES);
      await expect(
        compilePortableResourceArtifacts({
          rootDir: dir,
          resources: [guideResource("reference", `{% figure src="${reference}" alt="Hero" /%}\n`)],
          sourcePathsByResource: { "Guide/reference": "guide.md" },
          randomBytes: entropy(),
        }),
      ).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([expect.objectContaining({ id, severity: "error" })]),
      });
    },
  );

  test("preserves canonical root-relative reference spelling", async () => {
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "café.png"), PNG_BYTES);
    const reference = "assets/caf%C3%A9.png";
    const result = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("canonical", `![Hero](${reference})\n`)],
      sourcePathsByResource: { "Guide/canonical": "guide.md" },
      randomBytes: entropy(),
    });
    expect(result.artifacts[0].resource.spec.content.value).toContain(reference);
    expect(Object.values(result.artifacts[0].manifest.assets)).toMatchObject([
      { path: "assets/café.png" },
    ]);
  });

  test("rejects raw non-ASCII Markdown destinations before parser normalization", async () => {
    await writeFile(join(dir, "é.png"), PNG_BYTES);
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [guideResource("raw", "![Hero](é.png)\n")],
        sourcePathsByResource: { "Guide/raw": "guide.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID" }),
      ]),
    });
  });

  test("rejects raw non-ASCII reference-style image destinations with typed diagnostics", async () => {
    await writeFile(join(dir, "é.png"), PNG_BYTES);
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [guideResource("raw-reference", "![Hero][id]\n\n[id]: é.png\n")],
        sourcePathsByResource: { "Guide/raw-reference": "guide.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", severity: "error" }),
      ]),
    });
  });

  test.each([
    ["inline raw image", "![Nested [image]](é.png)\n"],
    ["reference entity image", "![Nested [image]][id]\n\n[id]: &eacute;.png\n"],
    ["image nested in a link label", "[![Nested image](é.png)](manual.bin)\n"],
    ["inline escaped download", "[Nested [download]](manual\\.bin)\n"],
    ["reference raw download", "[Nested [download]][id]\n\n[id]: é.bin\n"],
  ])("rejects a noncanonical %s destination behind a nested label", async (_name, content) => {
    await writeFile(join(dir, "é.png"), PNG_BYTES);
    await writeFile(join(dir, "é.bin"), "download");
    await writeFile(join(dir, "manual.bin"), "download");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [guideResource("nested-invalid", content)],
        sourcePathsByResource: { "Guide/nested-invalid": "guide.md" },
        randomBytes: entropy(),
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", severity: "error" }),
      ]),
    });
  });

  test("compiles canonical image and download destinations behind nested labels", async () => {
    await writeFile(join(dir, "é.png"), PNG_BYTES);
    await writeFile(join(dir, "manual.bin"), "download");
    const result = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [
        guideResource(
          "nested-canonical",
          [
            "![Nested [image]](%C3%A9.png)",
            "[Nested [download]](manual.bin)",
            "[Nested reference [download]][download-id]",
            "",
            "[download-id]: manual.bin",
          ].join("\n\n"),
        ),
      ],
      sourcePathsByResource: { "Guide/nested-canonical": "guide.md" },
      randomBytes: entropy(),
    });
    expect(Object.values(result.artifacts[0].manifest.assets)).toMatchObject([
      { path: "manual.bin" },
      { path: "é.png" },
    ]);
  });

  test.each([
    ["inline raw image", "![Code `]`](é.png)\n"],
    ["reference entity image", "![Code `[`][id]\n\n[id]: &eacute;.png\n"],
    ["inline escaped download", "[Code `]`](manual\\.bin)\n"],
    ["reference raw download", "[Code `[`][id]\n\n[id]: é.bin\n"],
  ])("rejects a noncanonical %s destination behind a code-span label", async (_name, content) => {
    await writeFile(join(dir, "é.png"), PNG_BYTES);
    await writeFile(join(dir, "é.bin"), "download");
    await writeFile(join(dir, "manual.bin"), "download");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [guideResource("code-label-invalid", content)],
        sourcePathsByResource: { "Guide/code-label-invalid": "guide.md" },
        randomBytes: entropy(),
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", severity: "error" }),
      ]),
    });
  });

  test("compiles canonical image and download destinations behind code-span labels", async () => {
    await writeFile(join(dir, "é.png"), PNG_BYTES);
    await writeFile(join(dir, "manual.bin"), "download");
    const result = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [
        guideResource(
          "code-label-canonical",
          [
            "![Inline `]`](%C3%A9.png)",
            "![Reference `[`][image-id]",
            "[Inline `]`](manual.bin)",
            "[Reference `[`][download-id]",
            "",
            "[image-id]: %C3%A9.png",
            "[download-id]: manual.bin",
          ].join("\n"),
        ),
      ],
      sourcePathsByResource: { "Guide/code-label-canonical": "guide.md" },
      randomBytes: entropy(),
    });
    expect(Object.values(result.artifacts[0].manifest.assets)).toMatchObject([
      { path: "manual.bin" },
      { path: "é.png" },
    ]);
    expect(result.artifacts[0].snapshot.occurrences).toHaveLength(4);
  });

  test.each([
    "![Hero](&eacute;.png)\n",
    "![Hero][id]\n\n[id]: &eacute;.png\n",
    "![Hero](hero\\.png)\n",
  ])("rejects parser-unescaped destination bytes with typed diagnostics", async (content) => {
    await writeFile(join(dir, "é.png"), PNG_BYTES);
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [guideResource("unescaped", content)],
        sourcePathsByResource: { "Guide/unescaped": "guide.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", severity: "error" }),
      ]),
    });
  });

  test.each([
    "![Hero][id]\n\n[id]:\n  é.png\n",
    '![Hero][id]\n\n[id]:\n  &eacute;.png\n  "Title"\n',
  ])(
    "rejects parser-normalized continuation destinations with typed diagnostics",
    async (content) => {
      await writeFile(join(dir, "é.png"), PNG_BYTES);
      await expect(
        compilePortableResourceArtifacts({
          rootDir: dir,
          resources: [guideResource("continued", content)],
          sourcePathsByResource: { "Guide/continued": "guide.md" },
        }),
      ).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", severity: "error" }),
        ]),
      });
    },
  );
});

function guideResource(name: string, content: string): Guide {
  return {
    apiVersion: "v1",
    type: "Guide",
    name,
    spec: { title: name, slug: name, content: { format: "topik", value: content } },
  };
}

function wikiPageResource(name: string, content: string): WikiPage {
  return {
    apiVersion: "v1",
    type: "WikiPage",
    name,
    spec: { wiki: "wiki", title: name, content: { format: "topik", value: content } },
  };
}
