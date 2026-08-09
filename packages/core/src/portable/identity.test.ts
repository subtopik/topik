import { describe, expect, test } from "vite-plus/test";
import type { Asset } from "@topik/schema";
import { createTopikMaterializationRecord, validateTopikMaterializationRecord } from "./identity";

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

describe("exact Asset materialization inventory", () => {
  test("requires both the Asset descriptor and its payload", () => {
    const complete = createTopikMaterializationRecord(
      [{ resource: asset, bytes: new TextEncoder().encode("descriptor\n") }],
      [{ path: asset.spec.uri, bytes, assetNames: [asset.name] }],
    );
    expect(validateTopikMaterializationRecord(complete, [asset])).toMatchObject({ ok: true });
    expect(complete.resources).toEqual([
      expect.objectContaining({ resource: "Asset/manual", path: "Asset/manual.json" }),
    ]);

    const noDescriptor = createTopikMaterializationRecord(
      [],
      [{ path: asset.spec.uri, bytes, assetNames: [asset.name] }],
    );
    expect(validateTopikMaterializationRecord(noDescriptor, [asset])).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });

    const noPayload = createTopikMaterializationRecord(
      [{ resource: asset, bytes: new TextEncoder().encode("descriptor\n") }],
      [],
    );
    expect(validateTopikMaterializationRecord(noPayload, [asset])).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_INVENTORY_INCOMPLETE" }],
    });
  });
});
