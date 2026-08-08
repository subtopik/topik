import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { AssetManifestV1 } from "@topik/schema";
import {
  readPortableAssetFile,
  sniffPortableMediaType,
  validatePortableAssetFile,
  validatePortableAssetSnapshot,
  type PortableAssetFileDescriptor,
} from "./index";
import { readPortableAssetFileWithTraversalHookForTest } from "./files";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const KEY = "ast_00000000000000000000000000";
const MARKUP_INSPECTION_LIMIT = 64 * 1024;
const BOUNDARY_ACTIVE_MARKUP = [
  ["HTML", "<html", "<html><body>x</body></html>"],
  ["SVG", "<svg", '<svg xmlns="http://www.w3.org/2000/svg" />'],
  ["XML", "<?xml", '<?xml version="1.0"?><html><body>x</body></html>'],
  ["comment", "<!--", "<!-- generated --><html><body>x</body></html>"],
  ["HTML doctype", "<!doctype html", "<!DOCTYPE html><html><body>x</body></html>"],
  ["SVG doctype", "<!doctype svg", "<!DOCTYPE svg><svg />"],
] as const;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(
  bytes: Uint8Array = PNG_BYTES,
  overrides: Partial<AssetManifestV1["assets"][string]> = {},
): AssetManifestV1 {
  return {
    apiVersion: "v1",
    assets: {
      [KEY]: {
        path: "assets/hero.png",
        digest: { algorithm: "sha256", value: digest(bytes) },
        size: bytes.byteLength,
        mediaType: "image/png",
        ...overrides,
      },
    },
    pathRules: "topik-path-v1",
    referenceRules: "topik-asset-reference-v1",
    resource: { apiVersion: "v1", type: "Guide", name: "guide", path: "guide.json" },
    serializer: "topik-json-v1",
    type: "AssetManifest",
  };
}

function file(
  bytes: Uint8Array = PNG_BYTES,
  overrides: Partial<PortableAssetFileDescriptor> = {},
): PortableAssetFileDescriptor {
  return {
    path: "assets/hero.png",
    type: "regular",
    mode: "100644",
    bytes,
    linkCount: 1,
    ...overrides,
  };
}

function validate(
  source = "![First](assets/hero.png)\n\n![Second](assets/hero.png)",
  manifestValue = manifest(),
  files: readonly PortableAssetFileDescriptor[] = [file()],
) {
  return validatePortableAssetSnapshot({
    manifest: manifestValue,
    resource: manifestValue.resource,
    contents: [{ path: "content.md", source }],
    files,
  });
}

describe("portable manifest/resource/occurrence/file validation", () => {
  test("retains duplicate occurrences that share one entry and verifies exact bytes", () => {
    const result = validate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurrences).toHaveLength(2);
    expect(result.value.occurrences.map((occurrence) => occurrence.assetKey)).toEqual([KEY, KEY]);
    expect(result.value.files[0]).toMatchObject({
      key: KEY,
      digest: digest(PNG_BYTES),
      verifiedMediaType: "image/png",
    });
  });

  test.each([
    ["missing occurrence", "![x](assets/missing.png)", "TOPIK_ASSET_MANIFEST_INCOMPLETE"],
    ["unreferenced entry", "# none", "TOPIK_ASSET_ENTRY_UNREFERENCED"],
    [
      "missing alt",
      '{% figure src="assets/hero.png" alt="" /%}',
      "TOPIK_ASSET_REFERENCE_ACCESSIBILITY_INVALID",
    ],
  ])("rejects %s", (_name, source, id) => {
    const result = validate(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((diagnostic) => diagnostic.id === id)).toBe(true);
  });

  test("rejects resource, digest, size, and verified media mismatches", () => {
    const base = manifest();
    const resourceMismatch = validatePortableAssetSnapshot({
      manifest: base,
      resource: { ...base.resource, name: "other" },
      contents: [{ path: "content.md", source: "![x](assets/hero.png)" }],
      files: [file()],
    });
    expect(resourceMismatch.ok).toBe(false);
    if (!resourceMismatch.ok) {
      expect(
        resourceMismatch.diagnostics.some((d) => d.id === "TOPIK_ASSET_RESOURCE_MISMATCH"),
      ).toBe(true);
    }

    const bad = manifest(PNG_BYTES, {
      digest: { algorithm: "sha256", value: "0".repeat(64) },
      size: 1,
      mediaType: "image/jpeg",
    });
    const result = validate("![x](assets/hero.png)", bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(new Set(result.diagnostics.map((diagnostic) => diagnostic.id))).toEqual(
      expect.objectContaining(
        new Set([
          "TOPIK_ASSET_DIGEST_MISMATCH",
          "TOPIK_ASSET_SIZE_MISMATCH",
          "TOPIK_ASSET_MEDIA_TYPE_MISMATCH",
        ]),
      ),
    );
  });

  test("allows zero-byte opaque downloads but never renders them inline", () => {
    const bytes = new Uint8Array();
    const opaque = manifest(bytes, {
      path: "files/empty.bin",
      mediaType: "application/octet-stream",
    });
    expect(
      validatePortableAssetSnapshot({
        manifest: opaque,
        resource: opaque.resource,
        contents: [{ path: "content.md", source: "[empty](files/empty.bin)" }],
        files: [file(bytes, { path: "files/empty.bin" })],
      }),
    ).toMatchObject({ ok: true });
    const inline = validatePortableAssetSnapshot({
      manifest: opaque,
      resource: opaque.resource,
      contents: [{ path: "content.md", source: "![empty](files/empty.bin)" }],
      files: [file(bytes, { path: "files/empty.bin" })],
    });
    expect(inline.ok).toBe(false);
    if (!inline.ok) {
      expect(
        inline.diagnostics.some((d) => d.id === "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED"),
      ).toBe(true);
    }
  });

  test("preserves external HTTPS occurrences without file or manifest ownership", () => {
    const empty = { ...manifest(), assets: {} };
    const exact = "https://example.com/hero.png?q=1#dark";
    const result = validatePortableAssetSnapshot({
      manifest: empty,
      resource: empty.resource,
      contents: [{ path: "content.md", source: `![hero](${exact})` }],
      files: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.occurrences[0].reference).toBe(exact);
  });

  test.each([
    ["comment-prefixed HTML", "<!-- generated -->\n<!doctype html><title>x</title>", "text/html"],
    ["padded HTML", `${" ".repeat(4096)}<html><body>x</body></html>`, "text/html"],
    ["text-prefixed HTML", "generated:\n<html><body>x</body></html>", "text/html"],
    ["XML-prefixed HTML", '<?xml version="1.0"?><html><body>x</body></html>', "text/html"],
    ["HTML document", "<html><body>x</body></html>", "text/html"],
    ["HTML fragment", "<div>fragment</div>", "text/html"],
    ["script fragment", "<script>alert(1)</script>", "text/html"],
    ["active body fragment", '<body onload="alert(1)">x</body>', "text/html"],
    ["SVG", '<svg xmlns="http://www.w3.org/2000/svg"><script /></svg>', "image/svg+xml"],
    [
      "padded SVG",
      `${" ".repeat(4096)}<svg xmlns="http://www.w3.org/2000/svg" />`,
      "image/svg+xml",
    ],
    [
      "text-prefixed SVG",
      'generated:\n<svg xmlns="http://www.w3.org/2000/svg" />',
      "image/svg+xml",
    ],
    ["SVG doctype", '<!DOCTYPE svg PUBLIC "x"><svg />', "image/svg+xml"],
    [
      "XML/comment-prefixed SVG",
      '<?xml version="1.0"?><!-- generated --><svg xmlns="http://www.w3.org/2000/svg" />',
      "image/svg+xml",
    ],
    [
      "inspection-exhausting HTML padding",
      `${" ".repeat(64 * 1024)}<html><body>x</body></html>`,
      "application/x-topik-active-content",
    ],
    [
      "inspection-exhausting comment",
      `<!--${" ".repeat(64 * 1024)}--><html><body>x</body></html>`,
      "text/html",
    ],
    [
      "inspection-exhausting XML declaration",
      `<?xml${" ".repeat(64 * 1024)}?><svg />`,
      "application/x-topik-active-content",
    ],
    ["Unix executable", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1]), "application/x-executable"],
    ["Windows executable", new Uint8Array([0x4d, 0x5a, 0, 0]), "application/x-executable"],
    ["script executable", "#!/bin/sh\necho unsafe\n", "application/x-executable"],
  ])("requires an explicit download policy for recognizable %s", (_name, source, mediaType) => {
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
    expect(sniffPortableMediaType(bytes)).toBe(mediaType);
    const active = manifest(bytes, { path: "files/active.bin", mediaType });
    const input = {
      manifest: active,
      resource: active.resource,
      contents: [{ path: "content.md", source: "[Download](files/active.bin)" }],
      files: [file(bytes, { path: "files/active.bin" })],
    };
    expect(validatePortableAssetSnapshot(input)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED" }),
      ]),
    });
    expect(validatePortableAssetSnapshot({ ...input, allowActiveDownloads: true })).toMatchObject({
      ok: true,
    });
  });

  test.each([
    ["plain text", "ordinary offline download"],
    ["bounded whitespace", " ".repeat(64 * 1024)],
    ["binary controls", new Uint8Array([0, 1, 2, 3, 4])],
  ])("keeps genuine opaque %s as an attachment-safe media type", (_name, source) => {
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
    expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  });

  test("fails closed for active markup split anywhere across the inspection boundary", () => {
    for (const [name, prefix, payload] of BOUNDARY_ACTIVE_MARKUP) {
      for (let visiblePrefixBytes = 0; visiblePrefixBytes <= prefix.length; visiblePrefixBytes++) {
        const source = `${" ".repeat(MARKUP_INSPECTION_LIMIT - visiblePrefixBytes)}${payload}`;
        const detected = sniffPortableMediaType(new TextEncoder().encode(source));
        expect(`${name}:${visiblePrefixBytes}:${detected}`).not.toContain(
          ":application/octet-stream",
        );
      }

      const visiblePrefixBytes = Math.floor(prefix.length / 2);
      const bytes = new TextEncoder().encode(
        `${" ".repeat(MARKUP_INSPECTION_LIMIT - visiblePrefixBytes)}${payload}`,
      );
      const mediaType = sniffPortableMediaType(bytes);
      const active = manifest(bytes, { path: "files/active.bin", mediaType });
      const result = validatePortableAssetSnapshot({
        manifest: active,
        resource: active.resource,
        contents: [{ path: "content.md", source: "[Download](files/active.bin)" }],
        files: [file(bytes, { path: "files/active.bin" })],
      });
      expect({ name, result }).toMatchObject({
        name,
        result: {
          ok: false,
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ id: "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED" }),
          ]),
        },
      });
    }
  });
});

describe("portable file security", () => {
  test.each([
    ["symlink", { type: "symlink" }],
    ["hard link", { type: "hardlink" }],
    ["gitlink", { type: "gitlink", mode: "160000" }],
    ["executable", { mode: "100755" }],
    ["ADS", { hasAlternateDataStream: true }],
    ["LFS attribute", { contentFilter: "lfs" }],
    ["filter", { contentFilter: "custom" }],
    ["encoding", { workingTreeEncoding: "utf-16" }],
  ])("rejects %s descriptors", (_name, overrides) => {
    expect(validatePortableAssetFile(file(PNG_BYTES, overrides as never))).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }],
    });
  });

  test("rejects LFS pointers and near-miss signatures", () => {
    const pointer = new TextEncoder().encode(
      "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 1\n",
    );
    expect(validatePortableAssetFile(file(pointer))).toMatchObject({ ok: false });
  });

  test("enforces source-specific Git and archive modes", () => {
    expect(
      validatePortableAssetFile(file(PNG_BYTES, { source: "git", mode: "100644" })),
    ).toMatchObject({ ok: true });
    expect(
      validatePortableAssetFile(file(PNG_BYTES, { source: "archive", mode: "0644" })),
    ).toMatchObject({ ok: true });
    expect(
      validatePortableAssetFile(file(PNG_BYTES, { source: "git", mode: "0644" })),
    ).toMatchObject({ ok: false });
    expect(
      validatePortableAssetFile(file(PNG_BYTES, { source: "archive", mode: "100644" })),
    ).toMatchObject({ ok: false });
    expect(validatePortableAssetFile(file(PNG_BYTES, { mode: "0644" }))).toMatchObject({
      ok: true,
    });
  });
});

describe("filesystem no-follow reader", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("accepts a stable regular file and rejects symlink traversal and hard links", async () => {
    const root = await mkdtemp(join(tmpdir(), "topik-portable-files-"));
    roots.push(root);
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "hero.png"), PNG_BYTES, { mode: 0o644 });
    expect(await readPortableAssetFile({ root, path: "assets/hero.png" })).toMatchObject({
      ok: true,
    });

    await symlink("assets", join(root, "linked"));
    expect(await readPortableAssetFile({ root, path: "linked/hero.png" })).toMatchObject({
      ok: false,
    });

    await link(join(root, "assets", "hero.png"), join(root, "assets", "copy.png"));
    expect(await readPortableAssetFile({ root, path: "assets/copy.png" })).toMatchObject({
      ok: false,
    });
  });

  test("rejects a symlink supplied as the resource root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "topik-portable-root-link-"));
    roots.push(parent);
    const realRoot = join(parent, "real");
    const linkedRoot = join(parent, "linked");
    await mkdir(realRoot);
    await writeFile(join(realRoot, "hero.png"), PNG_BYTES);
    await symlink(realRoot, linkedRoot, "dir");

    expect(await readPortableAssetFile({ root: linkedRoot, path: "hero.png" })).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }],
    });
  });

  test.each([
    ["Git LFS", "*.png filter=lfs\n"],
    ["custom filter", "hero.png filter=custom\n"],
    ["working-tree encoding", "*.png working-tree-encoding=UTF-16\n"],
    ["explicitly unset filter", "hero.png -filter\n"],
    ["explicitly unset working-tree encoding", "hero.png -working-tree-encoding\n"],
    ["unproven character-class pattern", "[h]ero.png filter=lfs\n"],
    ["unproven recursive pattern", "**/*.png filter=lfs\n"],
  ])("rejects effective or unproven %s attributes", async (_name, attributes) => {
    const root = await mkdtemp(join(tmpdir(), "topik-portable-attributes-"));
    roots.push(root);
    await writeFile(join(root, ".gitattributes"), attributes);
    await writeFile(join(root, "hero.png"), PNG_BYTES);

    expect(await readPortableAssetFile({ root, path: "hero.png" })).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }],
    });
  });

  test("accepts only explicit resets to unspecified in nested Git attributes", async () => {
    const root = await mkdtemp(join(tmpdir(), "topik-portable-attributes-override-"));
    roots.push(root);
    await mkdir(join(root, "assets"));
    await writeFile(
      join(root, ".gitattributes"),
      "*.png filter=custom working-tree-encoding=UTF-16\n",
    );
    await writeFile(
      join(root, "assets", ".gitattributes"),
      "hero.png !filter !working-tree-encoding\n",
    );
    await writeFile(join(root, "assets", "hero.png"), PNG_BYTES);

    expect(await readPortableAssetFile({ root, path: "assets/hero.png" })).toMatchObject({
      ok: true,
    });
  });

  test("matches Git attribute anchors relative to the declaring directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "topik-portable-attribute-anchors-"));
    roots.push(root);
    await mkdir(join(root, "assets", "deeper"), { recursive: true });
    await writeFile(
      join(root, ".gitattributes"),
      [
        "/root-only.png filter=lfs",
        "basename.png filter=custom",
        "assets/slashed.png working-tree-encoding=UTF-16",
      ].join("\n"),
    );
    await writeFile(join(root, "assets", ".gitattributes"), "/nested-only.png filter=lfs\n");
    for (const path of [
      "root-only.png",
      "assets/root-only.png",
      "assets/basename.png",
      "assets/slashed.png",
      "assets/nested-only.png",
      "assets/deeper/nested-only.png",
    ]) {
      await writeFile(join(root, path), PNG_BYTES);
    }

    expect(await readPortableAssetFile({ root, path: "root-only.png" })).toMatchObject({
      ok: false,
    });
    expect(await readPortableAssetFile({ root, path: "assets/root-only.png" })).toMatchObject({
      ok: true,
    });
    expect(await readPortableAssetFile({ root, path: "assets/basename.png" })).toMatchObject({
      ok: false,
    });
    expect(await readPortableAssetFile({ root, path: "assets/slashed.png" })).toMatchObject({
      ok: false,
    });
    expect(await readPortableAssetFile({ root, path: "assets/nested-only.png" })).toMatchObject({
      ok: false,
    });
    expect(
      await readPortableAssetFile({ root, path: "assets/deeper/nested-only.png" }),
    ).toMatchObject({ ok: true });
  });

  test("stays anchored when an opened directory is swapped to a symlink", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "topik-portable-race-root-"));
    const outside = await mkdtemp(join(tmpdir(), "topik-portable-race-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "hero.png"), PNG_BYTES, { mode: 0o644 });
    await writeFile(join(outside, "hero.png"), new Uint8Array([1, 2, 3]), { mode: 0o644 });

    let swapped = false;
    const result = await readPortableAssetFileWithTraversalHookForTest(
      { root, path: "assets/hero.png" },
      async (components) => {
        if (swapped || components.join("/") !== "assets") return;
        swapped = true;
        await rename(join(root, "assets"), join(root, "assets-original"));
        await symlink(outside, join(root, "assets"));
      },
    );

    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.bytes).toEqual(PNG_BYTES);
  });
});
