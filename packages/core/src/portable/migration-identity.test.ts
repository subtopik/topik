import { createHash } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { extractTopikAssetOccurrences } from "@topik/content-schema";
import type { Asset, AssetManifestV1, Guide } from "@topik/schema";
import {
  TOPIK_LEGACY_ASSET_MIGRATION_VERSION,
  compareTopikAssetIdentities,
  createTopikAssetSemanticRecord,
  createTopikMaterializationRecord,
  digestTopikAssetSemanticRecord,
  digestTopikMaterializationRecord,
  migrateLegacyAssets,
  parseAssetManifest,
  serializeTopikJson,
  validatePortableAssetSnapshot,
  type LegacyAssetMigrationRetryState,
  type PortableAssetFileDescriptor,
  type ResolvedTopikAssetOccurrence,
  type TopikMaterializationDescriptorsV1,
} from "./index";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const digest = createHash("sha256").update(PNG_BYTES).digest();
const name = digest.toString("hex").slice(0, 16);
const asset: Asset = {
  apiVersion: "v1",
  type: "Asset",
  name,
  spec: {
    uri: "images/hero.png",
    integrity: `sha256-${digest.toString("base64")}`,
    mediaType: "image/png",
  },
};
const source = `![Hero](asset:${name})\n`;
const guide: Guide = {
  apiVersion: "v1",
  type: "Guide",
  name: "guide",
  spec: {
    title: "Guide",
    slug: "guide",
    content: { format: "topik", value: source },
    assets: [name],
  },
};
const state: LegacyAssetMigrationRetryState = {
  version: TOPIK_LEGACY_ASSET_MIGRATION_VERSION,
  keysByLegacyAsset: {},
  reservedKeys: [],
  retiredKeys: [],
};

function original(resource: Guide = guide, assets = [{ resource: asset, bytes: bytes(asset) }]) {
  return {
    contentPath: "guide.md",
    contentBytes: new TextEncoder().encode(resource.spec.content.value),
    resourcePath: "guide.json",
    resourceBytes: bytes(resource),
    resource,
    assets,
  };
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeTopikJson(value));
}

function emptySidecarBytes(): Uint8Array {
  return bytes({
    apiVersion: "v1",
    assets: {},
    pathRules: "topik-path-v1",
    referenceRules: "topik-asset-reference-v1",
    resource: { apiVersion: "v2", name: "guide", path: "guide.json", type: "Guide" },
    serializer: "topik-json-v1",
    type: "AssetManifest",
  });
}

function provider(path = "images/hero.png", fileBytes: Uint8Array = PNG_BYTES) {
  return {
    async read(requested: string): Promise<PortableAssetFileDescriptor | undefined> {
      return requested === path
        ? { path, type: "regular", mode: "100644", bytes: fileBytes, linkCount: 1 }
        : undefined;
    },
  };
}

describe("explicit legacy asset migration", () => {
  test("verifies bytes, emits v2 plus one canonical sidecar, and preserves exact source", async () => {
    const result = await migrateLegacyAssets({
      original: original(),
      byteProvider: provider(),
      state,
      randomBytes: () => new Uint8Array(16),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.value.resource).toMatchObject({ apiVersion: "v2", type: "Guide" });
    expect(result.value.resource.spec).not.toHaveProperty("assets");
    expect(result.value.content).toBe("![Hero](images/hero.png)\n");
    expect(Object.keys(result.value.manifest.assets)).toEqual(["ast_00000000000000000000000000"]);
    expect(result.value.manifest.resource).toEqual({
      apiVersion: "v2",
      type: "Guide",
      name: "guide",
      path: "guide.json",
    });
    expect(parseAssetManifest(result.value.manifestBytes)).toMatchObject({ ok: true });
    expect(result.value.backup.contentBytes).toEqual(new TextEncoder().encode(source));
    expect(result.value.backup.resourceBytes).toEqual(bytes(guide));
    expect(guide.apiVersion).toBe("v1");
    expect(guide.spec.content.value).toBe(source);
  });

  test("converts provable root-absolute legacy paths", async () => {
    const rootSource = "![Hero](/images/hero.png)\n";
    const resource: Guide = {
      ...guide,
      spec: { ...guide.spec, content: { format: "topik", value: rootSource } },
    };
    const result = await migrateLegacyAssets({
      original: original(resource),
      byteProvider: provider(),
      state,
      randomBytes: () => new Uint8Array(16),
    });
    expect(result.ok && result.value.content).toBe("![Hero](images/hero.png)\n");
  });

  test("keeps light and dark figure occurrences distinct during migration", async () => {
    const darkBytes = Uint8Array.from(PNG_BYTES);
    darkBytes[darkBytes.length - 1] ^= 1;
    const makeAsset = (uri: string, fileBytes: Uint8Array): Asset => {
      const fileDigest = createHash("sha256").update(fileBytes).digest();
      return {
        apiVersion: "v1",
        type: "Asset",
        name: fileDigest.toString("hex").slice(0, 16),
        spec: {
          uri,
          integrity: `sha256-${fileDigest.toString("base64")}`,
          mediaType: "image/png",
        },
      };
    };
    const light = makeAsset("images/light.png", PNG_BYTES);
    const dark = makeAsset("images/dark.png", darkBytes);
    const themedSource = `{% figure src="asset:${light.name}" darkSrc="asset:${dark.name}" alt="Theme" /%}\n`;
    const themedGuide: Guide = {
      ...guide,
      spec: {
        ...guide.spec,
        assets: [light.name, dark.name],
        content: { format: "topik", value: themedSource },
      },
    };
    expect(
      extractTopikAssetOccurrences(themedSource).map((occurrence) => occurrence.reference),
    ).toEqual([`asset:${light.name}`, `asset:${dark.name}`]);
    const files = new Map<string, Uint8Array>([
      [light.spec.uri, PNG_BYTES],
      [dark.spec.uri, darkBytes],
    ]);
    let entropy = 0;
    const result = await migrateLegacyAssets({
      original: original(themedGuide, [
        { resource: light, bytes: bytes(light) },
        { resource: dark, bytes: bytes(dark) },
      ]),
      byteProvider: {
        async read(path) {
          const fileBytes = files.get(path);
          return fileBytes === undefined
            ? undefined
            : { path, type: "regular", mode: "100644", bytes: fileBytes, linkCount: 1 };
        },
      },
      state,
      randomBytes: () => new Uint8Array(16).fill(entropy++),
    });

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain('src="images/light.png"');
    expect(result.value.content).toContain('darkSrc="images/dark.png"');
    expect(
      Object.values(result.value.manifest.assets)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["images/dark.png", "images/light.png"]);
  });

  test("reuses persisted retry keys and produces stable target bytes", async () => {
    const first = await migrateLegacyAssets({
      original: original(),
      byteProvider: provider(),
      state,
      randomBytes: () => new Uint8Array(16),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const retry = await migrateLegacyAssets({
      original: original(),
      byteProvider: provider(),
      state: first.value.state,
      randomBytes: () => new Uint8Array(16).fill(255),
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.manifestBytes).toEqual(first.value.manifestBytes);
    expect(retry.value.resourceBytes).toEqual(first.value.resourceBytes);
    expect(retry.value.contentBytes).toEqual(first.value.contentBytes);
  });

  test("fails on ambiguous digest prefixes and proven lost paths", async () => {
    const duplicateAsset = { ...asset, spec: { ...asset.spec, uri: "other/hero.png" } };
    const ambiguous = await migrateLegacyAssets({
      original: original(guide, [
        { resource: asset, bytes: bytes(asset) },
        { resource: duplicateAsset, bytes: bytes(duplicateAsset) },
      ]),
      byteProvider: provider(),
      state,
    });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.diagnostics[0].id).toBe("TOPIK_LEGACY_ASSET_REFERENCE_AMBIGUOUS");
    }

    const positionProbe = await migrateLegacyAssets({
      original: original(),
      byteProvider: provider(),
      state,
      occurrencePathsByPosition: new Proxy({}, { get: () => "other/hero.png" }) as Readonly<
        Record<string, string>
      >,
    });
    expect(positionProbe.ok).toBe(false);
    if (!positionProbe.ok) {
      expect(
        positionProbe.diagnostics.some(
          (diagnostic) => diagnostic.id === "TOPIK_LEGACY_ASSET_REFERENCE_AMBIGUOUS",
        ),
      ).toBe(true);
    }
  });
});

describe("semantic and exact identities", () => {
  test("canonicalizes occurrence order across content enumeration order", () => {
    const semanticManifest = {
      ...JSON.parse(new TextDecoder().decode(emptySidecarBytes())),
      assets: {
        ast_00000000000000000000000000: {
          digest: { algorithm: "sha256", value: "0".repeat(64) },
          mediaType: "image/png",
          path: "images/a.png",
          size: 1,
        },
        ast_00000000000000000000000001: {
          digest: { algorithm: "sha256", value: "1".repeat(64) },
          mediaType: "image/png",
          path: "images/b.png",
          size: 1,
        },
      },
    } as AssetManifestV1;
    const occurrences: ResolvedTopikAssetOccurrence[] = [
      {
        assetKey: "ast_00000000000000000000000001",
        contentPath: "z.md",
        decodedPath: "images/b.png",
        kind: "local",
        position: "/children/0/attributes/src",
        reference: "images/b.png",
        role: "image",
        semantics: { alt: "B" },
        slot: "image.src",
        treePath: [0],
      },
      {
        assetKey: "ast_00000000000000000000000000",
        contentPath: "a.md",
        decodedPath: "images/a.png",
        kind: "local",
        position: "/children/0/attributes/src",
        reference: "images/a.png",
        role: "image",
        semantics: { alt: "A" },
        slot: "image.src",
        treePath: [0],
      },
    ];
    const left = createTopikAssetSemanticRecord(semanticManifest, occurrences);
    const right = createTopikAssetSemanticRecord(semanticManifest, [...occurrences].reverse());
    expect(left.occurrences.map((occurrence) => occurrence.contentPath)).toEqual(["a.md", "z.md"]);
    expect(digestTopikAssetSemanticRecord(left)).toBe(digestTopikAssetSemanticRecord(right));
  });

  test("separates semantic identity from complete tree materialization", async () => {
    const migrated = await migrateLegacyAssets({
      original: original(),
      byteProvider: provider(),
      state,
      randomBytes: () => new Uint8Array(16),
    });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const snapshot = validatePortableAssetSnapshot({
      manifest: migrated.value.manifest,
      resource: migrated.value.manifest.resource,
      contents: [{ path: "guide.md", source: migrated.value.content }],
      files: migrated.value.files,
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const semantic = createTopikAssetSemanticRecord(
      migrated.value.manifest,
      snapshot.value.occurrences,
    );
    expect(digestTopikAssetSemanticRecord(semantic)).toMatch(/^[0-9a-f]{64}$/u);

    const descriptors: TopikMaterializationDescriptorsV1 = {
      resourceApi: "Guide/v2",
      contentApi: "topik-content/0.1",
      contentSchema: "0.1.0",
      manifestApi: "AssetManifest/v1",
      pathRules: "topik-path-v1",
      referenceRules: "topik-asset-reference-v1",
      serializer: "topik-json-v1",
      materializer: "topik-materialization-v1",
      mapping: "resource-root-v1",
      ownershipClassifier: "topik-assets-v1",
    };
    const exactA = createTopikMaterializationRecord(
      descriptors,
      [
        { path: "guide.md", type: "regular", mode: "100644", bytes: migrated.value.contentBytes },
        { path: "images/hero.png", type: "regular", mode: "100644", bytes: PNG_BYTES },
      ],
      migrated.value.manifestBytes,
    );
    const exactB = createTopikMaterializationRecord(
      descriptors,
      [
        {
          path: "guide.md",
          type: "regular",
          mode: "100644",
          bytes: new TextEncoder().encode(`${migrated.value.content}\n`),
        },
        { path: "images/hero.png", type: "regular", mode: "100644", bytes: PNG_BYTES },
      ],
      migrated.value.manifestBytes,
    );
    expect(digestTopikMaterializationRecord(exactA)).not.toBe(
      digestTopikMaterializationRecord(exactB),
    );
    expect(
      compareTopikAssetIdentities(
        { semantic, materialization: exactA },
        { semantic, materialization: exactB },
      ),
    ).toMatchObject({ ok: true, value: { semanticEqual: true, exactEqual: false } });
    expect(exactA.sidecarBytes).toBe(new TextDecoder().decode(migrated.value.manifestBytes));
  });

  test("refuses comparisons when descriptors differ", () => {
    const semantic = {
      descriptor: "topik-asset-semantic-v1" as const,
      manifestDescriptors: {
        apiVersion: "v1",
        pathRules: "topik-path-v1",
        referenceRules: "topik-asset-reference-v1",
        serializer: "topik-json-v1",
      },
      resource: { apiVersion: "v2", type: "Guide", name: "guide", path: "guide.json" },
      occurrences: [],
    };
    const descriptors = {
      resourceApi: "Guide/v2",
      contentApi: "topik-content/0.1",
      contentSchema: "0.1.0",
      manifestApi: "AssetManifest/v1",
      pathRules: "topik-path-v1",
      referenceRules: "topik-asset-reference-v1",
      serializer: "topik-json-v1",
      materializer: "topik-materialization-v1" as const,
      mapping: "resource-root-v1",
      ownershipClassifier: "topik-assets-v1",
    };
    const left = createTopikMaterializationRecord(descriptors, [], emptySidecarBytes());
    const right = createTopikMaterializationRecord(
      { ...descriptors, mapping: "future" },
      [],
      emptySidecarBytes(),
    );
    expect(
      compareTopikAssetIdentities(
        { semantic, materialization: left },
        { semantic, materialization: right },
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_VERSION_INCOMPARABLE" }],
    });
  });
});
