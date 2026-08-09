import { describe, expect, test } from "vite-plus/test";
import type { Asset, Guide } from "@topik/schema";
import type { Resource } from "../resource";
import {
  createTopikMaterializationRecord,
  type TopikMaterializationRecordV1,
  validateTopikMaterializationRecord,
} from "./identity";
import { serializeTopikJson } from "./json";

const bytes = new TextEncoder().encode("payload\n");
const integrity = "sha256:d4e4877bac978b7952f0d544fc52ebff5411d351d129f1f056fa43f11da9af2b";
const asset: Asset = {
  apiVersion: "v1",
  type: "Asset",
  name: "manual",
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
    content: { format: "topik", value: "[Manual](asset:manual)\n" },
  },
};
const resources: Resource[] = [asset, guide];

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

describe("exact Asset materialization inventory", () => {
  test("validates every compiled resource descriptor and required payload", () => {
    const complete = completeRecord();
    expect(validateTopikMaterializationRecord(complete, resources)).toMatchObject({ ok: true });
    expect(complete.resources).toEqual([
      expect.objectContaining({ resource: "Asset/manual", path: "Asset/manual.json" }),
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
  });

  test("rejects corrupt descriptor and payload facts", () => {
    const corruptions: Array<(record: ReturnType<typeof mutableRecord>) => void> = [
      (record) => {
        record.resources[0].path = "../Asset/manual.json";
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
