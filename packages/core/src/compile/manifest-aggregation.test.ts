import { describe, expect, test } from "vite-plus/test";
import { generateAutomaticAssetName, parseAssetBlobUri, type CompiledAsset } from "../assets/asset";
import {
  createTopikAssetSemanticRecord,
  createTopikMaterializationRecord,
  validateTopikMaterializationRecord,
} from "../assets/identity";
import { serializeTopikJson } from "../assets/json";
import type { AssetCompilationResult, AssetPayload, CompiledResource } from "./assets";
import { mergeManifestCompilations } from "./manifest";

const bytes = new TextEncoder().encode("payload\n");
const digest = "d4e4877bac978b7952f0d544fc52ebff5411d351d129f1f056fa43f11da9af2b";
function group(directory: string): { directory: string; result: AssetCompilationResult } {
  const name = generateAutomaticAssetName({
    stableSourceNamespace: directory,
    normalizedPath: "manual.bin",
  });
  if (!name.ok) throw new Error("Invalid fixture namespace");
  const asset: CompiledAsset = {
    apiVersion: "v1",
    type: "Asset",
    name: name.value,
    spec: {
      uri: parseAssetBlobUri(`blobs/${digest}`),
      integrity: `sha256:${digest}`,
      size: bytes.byteLength,
      mediaType: "application/octet-stream",
    },
  };
  const guide: CompiledResource = {
    apiVersion: "v1",
    type: "Guide",
    name: directory,
    spec: {
      title: directory,
      slug: directory,
      content: { format: "topik", value: `[Manual](asset:${asset.name})\n` },
    },
  };
  const resources: CompiledResource[] = [asset, guide];
  const payloads: AssetPayload[] = [
    {
      path: asset.spec.uri,
      integrity: asset.spec.integrity,
      size: bytes.byteLength,
      bytes,
      mediaType: asset.spec.mediaType,
      assetNames: [asset.name],
    },
  ];
  const semantic = createTopikAssetSemanticRecord(
    [asset],
    [
      {
        resource: `Guide/${directory}`,
        position: "/children/0/children/0/attributes/href",
        slot: "link.href",
        name: asset.name,
      },
    ],
  );
  const materialization = createTopikMaterializationRecord(
    resources.map((resource) => ({
      resource,
      bytes: new TextEncoder().encode(serializeTopikJson(resource)),
    })),
    payloads,
  );
  return { directory, result: { resources, payloads, semantic, materialization } };
}

describe("manifest aggregate inventories", () => {
  test("deduplicates byte pins, unions names and references, and rebuilds complete inventories", () => {
    const a = group("a");
    const b = group("b");
    const result = mergeManifestCompilations([a, b]);
    expect(result.resources).toHaveLength(4);
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0].assetNames).toHaveLength(2);
    expect(result.semantic.references).toHaveLength(2);
    expect(
      validateTopikMaterializationRecord(result.materialization, result.resources, result.semantic)
        .ok,
    ).toBe(true);
    expect(mergeManifestCompilations([b, a])).toEqual(result);
  });
  test("rejects conflicting output bytes", () => {
    const a = group("a");
    const b = group("b");
    b.result.payloads[0] = {
      ...b.result.payloads[0],
      bytes: new TextEncoder().encode("changed\n"),
    };
    expect(() => mergeManifestCompilations([a, b])).toThrow(
      expect.objectContaining({ id: "manifest-output-conflict" }),
    );
  });
  test("rejects a repeated generated identity with different directory evidence", () => {
    const a = group("a");
    expect(() => mergeManifestCompilations([a, { ...a, directory: "other" }])).toThrow(
      expect.objectContaining({ id: "manifest-output-conflict" }),
    );
  });
  test("validates the aggregate rather than trusting supplied inventories", () => {
    const a = group("a");
    a.result.semantic.references = [];
    expect(() => mergeManifestCompilations([a])).toThrow();
  });
  test("creates valid inventories for the explicit empty project", () => {
    const result = mergeManifestCompilations([]);
    expect(result.resources).toEqual([]);
    expect(result.payloads).toEqual([]);
    expect(
      validateTopikMaterializationRecord(result.materialization, result.resources, result.semantic)
        .ok,
    ).toBe(true);
  });
});
