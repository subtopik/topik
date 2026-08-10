import { describe, expect, test } from "vite-plus/test";
import type { Asset, CoursePage, Guide, WikiPage } from "@topik/schema";
import type { Resource } from "../resource";
import {
  createTopikAssetSemanticRecord,
  createTopikMaterializationRecord,
  type TopikMaterializationRecordV1,
  validateTopikMaterializationRecord as validateMaterializationRecord,
} from "./identity";
import { serializeTopikJson } from "./json";

const bytes = new TextEncoder().encode("payload\n");
const integrity = "sha256:d4e4877bac978b7952f0d544fc52ebff5411d351d129f1f056fa43f11da9af2b";
const assetName = `auto-v1-${"a".repeat(52)}` as const;
const asset: Asset = {
  apiVersion: "v1",
  type: "Asset",
  name: assetName,
  spec: {
    uri: "assets/sha256/d4e4877bac978b7952f0d544fc52ebff5411d351d129f1f056fa43f11da9af2b",
    integrity,
    size: bytes.byteLength,
    mediaType: "application/octet-stream",
  },
};
const guide: Guide = {
  apiVersion: "v1",
  type: "Guide",
  name: "guide",
  spec: {
    title: "Guide",
    slug: "guide",
    content: { format: "topik", value: `[Manual](asset:${assetName})\n` },
  },
};
const resources: Resource[] = [asset, guide];
const semantic = createTopikAssetSemanticRecord(
  [asset],
  [
    {
      resource: "Guide/guide",
      position: "/children/0/children/0/children/0/attributes/href",
      slot: "link.href",
      name: assetName,
    },
  ],
);

function validateTopikMaterializationRecord(
  record: unknown,
  resourceSet: readonly Resource[] = resources,
  semanticRecord: unknown = semantic,
) {
  return validateMaterializationRecord(record, resourceSet, semanticRecord);
}

function completeRecord(): TopikMaterializationRecordV1 {
  return createTopikMaterializationRecord(
    resources.map((resource) => ({
      resource,
      bytes: new TextEncoder().encode(serializeTopikJson(resource)),
    })),
    [{ path: asset.spec.uri, bytes, assetNames: [asset.name] }],
  );
}

function mutableRecord(): {
  descriptor: string;
  resources: Array<{ resource: string; path: string; size: number; sha256: string }>;
  payloads: Array<{ path: string; size: number; sha256: string; assetNames: string[] }>;
} {
  return structuredClone(completeRecord()) as unknown as ReturnType<typeof mutableRecord>;
}

function noAssetMaterialization(
  content: string,
  resourceType: "Guide" | "WikiPage" | "CoursePage" = "Guide",
): {
  record: TopikMaterializationRecordV1;
  resources: readonly Resource[];
  semantic: ReturnType<typeof createTopikAssetSemanticRecord>;
} {
  const compiledContent = { format: "topik", value: content } as const;
  const contentResource: Guide | WikiPage | CoursePage =
    resourceType === "Guide"
      ? { ...guide, spec: { ...guide.spec, content: compiledContent } }
      : resourceType === "WikiPage"
        ? {
            apiVersion: "v1",
            type: "WikiPage",
            name: "wiki-page",
            spec: { wiki: "wiki", title: "Wiki page", content: compiledContent },
          }
        : {
            apiVersion: "v1",
            type: "CoursePage",
            name: "course-page",
            spec: {
              module: "module",
              title: "Course page",
              slug: "course-page",
              order: 0,
              content: compiledContent,
            },
          };
  const contentResources: readonly Resource[] = [contentResource];
  return {
    record: createTopikMaterializationRecord(
      contentResources.map((resource) => ({
        resource,
        bytes: new TextEncoder().encode(serializeTopikJson(resource)),
      })),
      [],
    ),
    resources: contentResources,
    semantic: createTopikAssetSemanticRecord([], []),
  };
}

describe("exact Asset materialization inventory", () => {
  test("validates every compiled resource descriptor and required payload", () => {
    const complete = completeRecord();
    expect(validateTopikMaterializationRecord(complete, resources)).toMatchObject({ ok: true });
    expect(complete.resources).toEqual([
      expect.objectContaining({
        resource: `Asset/${assetName}`,
        path: `Asset/${assetName}.json`,
      }),
      expect.objectContaining({ resource: "Guide/guide", path: "Guide/guide.json" }),
    ]);

    const noAssetDescriptor = mutableRecord();
    noAssetDescriptor.resources.shift();
    expect(validateTopikMaterializationRecord(noAssetDescriptor, resources)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });

    const noGuideDescriptor = mutableRecord();
    noGuideDescriptor.resources.pop();
    expect(validateTopikMaterializationRecord(noGuideDescriptor, resources)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });

    const noPayload = mutableRecord();
    noPayload.payloads = [];
    expect(validateTopikMaterializationRecord(noPayload, resources)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });

    const regeneratedWithoutPayload = createTopikMaterializationRecord(
      resources.map((resource) => ({
        resource,
        bytes: new TextEncoder().encode(serializeTopikJson(resource)),
      })),
      [],
    );
    expect(validateTopikMaterializationRecord(regeneratedWithoutPayload)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });

    const onlyGuide: Resource[] = [guide];
    const regeneratedWithoutAsset = createTopikMaterializationRecord(
      onlyGuide.map((resource) => ({
        resource,
        bytes: new TextEncoder().encode(serializeTopikJson(resource)),
      })),
      [],
    );
    expect(validateTopikMaterializationRecord(regeneratedWithoutAsset, onlyGuide)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });
  });

  test("requires complete canonical semantic mappings without orphaned Assets", () => {
    expect(validateMaterializationRecord(completeRecord(), resources, undefined)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_SCHEMA_INVALID" }],
    });
    expect(
      validateMaterializationRecord(completeRecord(), resources, {
        ...semantic,
        references: {},
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_SCHEMA_INVALID" }],
    });
    expect(
      validateMaterializationRecord(completeRecord(), resources, {
        ...semantic,
        references: [],
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });
    expect(
      validateMaterializationRecord(completeRecord(), resources, {
        ...semantic,
        references: [{ ...semantic.references[0], name: `auto-v1-${"b".repeat(52)}` }],
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });

    const unreferencedGuide: Guide = {
      ...guide,
      spec: {
        ...guide.spec,
        content: { format: "topik", value: "No Asset reference\n" },
      },
    };
    const orphanResources: Resource[] = [asset, unreferencedGuide];
    const orphanRecord = createTopikMaterializationRecord(
      orphanResources.map((resource) => ({
        resource,
        bytes: new TextEncoder().encode(serializeTopikJson(resource)),
      })),
      [{ path: asset.spec.uri, bytes, assetNames: [asset.name] }],
    );
    expect(
      validateMaterializationRecord(
        orphanRecord,
        orphanResources,
        createTopikAssetSemanticRecord([asset], []),
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });
  });

  test.each([
    ["local image", "![Local](hero.png)\n"],
    ["local figure", '{% figure src="hero.png" alt="Hero" /%}\n'],
    [
      "local dark figure",
      '{% figure src="https://example.com/hero.png" darkSrc="hero-dark.png" alt="Hero" /%}\n',
    ],
    ["generated Asset card navigation", `{% card title="Asset" href="asset:${assetName}" /%}\n`],
    ["unsafe HTTP image", "![Unsafe](http://example.com/hero.png)\n"],
    ["unsafe HTTP figure", '{% figure src="http://example.com/hero.png" alt="Hero" /%}\n'],
    ["unclosed compiled image", `![Compiled](asset:${assetName})\n`],
    ["unclosed compiled figure", `{% figure src="asset:${assetName}" alt="Hero" /%}\n`],
  ])("rejects incomplete compiled content semantics for %s", (_name, content) => {
    const state = noAssetMaterialization(content);
    expect(
      validateMaterializationRecord(state.record, state.resources, state.semantic),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });
  });

  test.each(["Guide", "WikiPage", "CoursePage"] as const)(
    "enforces compiled Asset-slot and navigation semantics for %s resources",
    (resourceType) => {
      for (const content of [
        "![Local](hero.png)\n",
        `{% card title="Asset" href="asset:${assetName}" /%}\n`,
      ]) {
        const state = noAssetMaterialization(content, resourceType);
        expect(
          validateMaterializationRecord(state.record, state.resources, state.semantic),
        ).toMatchObject({
          ok: false,
          diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
        });
      }
    },
  );

  test.each([
    ["plain content", "No Asset references.\n"],
    ["ordinary navigation", "[Next](next-page)\n"],
    ["card navigation", '{% card title="Next" href="next-page" /%}\n'],
    ["external image", "![External](https://example.com/hero.png)\n"],
    [
      "external figure",
      '{% figure src="https://example.com/hero.png" darkSrc="https://example.com/hero-dark.png" alt="Hero" /%}\n',
    ],
    [
      "unpaired effective external image",
      "![Unavailable][id] ![Hero](https://example.com/hero.png)\n\n> [id]: https://example.com/hero.png\n",
    ],
  ])("accepts complete no-Asset compiled content for %s", (_name, content) => {
    const state = noAssetMaterialization(content);
    expect(
      validateMaterializationRecord(state.record, state.resources, state.semantic),
    ).toMatchObject({
      ok: true,
      diagnostics: [],
    });
  });

  test("rejects unsupported and malformed materialization records with typed diagnostics", () => {
    const future = mutableRecord();
    future.descriptor = "topik-materialization-v2";
    expect(validateTopikMaterializationRecord(future, resources)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_UNSUPPORTED_VERSION" }],
    });
    expect(
      validateTopikMaterializationRecord(
        { descriptor: "topik-materialization-v1", payloads: [], resources: {} },
        resources,
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_SCHEMA_INVALID" }],
    });

    for (const descriptor of [null, 2, true, {}]) {
      expect(
        validateTopikMaterializationRecord({ ...mutableRecord(), descriptor }, resources),
      ).toMatchObject({
        ok: false,
        diagnostics: [{ id: "TOPIK_ASSET_SCHEMA_INVALID" }],
      });
    }
  });

  test("rejects accessors and custom prototypes without executing supplied getters", () => {
    let getterCalls = 0;
    const descriptorAccessor = {
      payloads: mutableRecord().payloads,
      resources: mutableRecord().resources,
    };
    Object.defineProperty(descriptorAccessor, "descriptor", {
      enumerable: true,
      get: () => {
        getterCalls++;
        throw new Error("must not execute");
      },
    });
    expect(validateTopikMaterializationRecord(descriptorAccessor, resources)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_SCHEMA_INVALID" }],
    });

    const nestedAccessor = mutableRecord();
    Object.defineProperty(nestedAccessor.resources[0], "path", {
      enumerable: true,
      get: () => {
        getterCalls++;
        throw new Error("must not execute");
      },
    });
    expect(validateTopikMaterializationRecord(nestedAccessor, resources)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_SCHEMA_INVALID" }],
    });
    expect(getterCalls).toBe(0);

    const customPrototype = Object.assign(Object.create({ inherited: true }), mutableRecord());
    expect(validateTopikMaterializationRecord(customPrototype, resources)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_SCHEMA_INVALID" }],
    });
  });

  test("rejects corrupt descriptor and payload facts", () => {
    const corruptions: Array<(record: ReturnType<typeof mutableRecord>) => void> = [
      (record) => {
        record.resources[0].path = `../Asset/${assetName}.json`;
      },
      (record) => {
        record.resources[0].size++;
      },
      (record) => {
        record.resources[0].sha256 = "0".repeat(64);
      },
      (record) => {
        record.payloads[0].size++;
      },
      (record) => {
        record.payloads[0].sha256 = "0".repeat(64);
      },
      (record) => {
        record.payloads[0].assetNames = [];
      },
    ];
    for (const corrupt of corruptions) {
      const record = mutableRecord();
      corrupt(record);
      expect(validateTopikMaterializationRecord(record, resources)).toMatchObject({
        ok: false,
        diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
      });
    }
  });

  test("rejects duplicate descriptor and payload inventory records", () => {
    const duplicateDescriptor = mutableRecord();
    duplicateDescriptor.resources.push({ ...duplicateDescriptor.resources[0] });
    expect(validateTopikMaterializationRecord(duplicateDescriptor, resources)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });

    const duplicatePayload = mutableRecord();
    duplicatePayload.payloads.push({
      ...duplicatePayload.payloads[0],
      assetNames: [...duplicatePayload.payloads[0].assetNames],
    });
    expect(validateTopikMaterializationRecord(duplicatePayload, resources)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });
  });
});
