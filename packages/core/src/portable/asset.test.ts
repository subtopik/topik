import { describe, expect, test } from "vite-plus/test";
import type { Asset, GeneratedAssetName } from "@topik/schema";
import {
  generateAutomaticAssetName,
  isGeneratedAssetName,
  parseAsset,
  serializeAsset,
  validateAssetValue,
  validateStableSourceNamespace,
} from "./asset";
import { parseStrictTopikJson, serializeTopikJson } from "./json";
import { sniffPortableMediaType, TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE } from "./media";
import { topikAssetDiagnostic } from "./diagnostics";
import { TOPIK_ASSET_LIMITS } from "./constants";

const complete: Asset = {
  apiVersion: "v1",
  type: "Asset",
  name: `auto-v1-${"a".repeat(52)}` as GeneratedAssetName,
  spec: {
    uri: "assets/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    integrity: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    size: 7,
    mediaType: "image/png",
  },
};
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

describe("Asset/v1 strict JSON", () => {
  test("serializes recursively ordered UTF-8 JSON with one final LF and strict reparses", () => {
    const result = serializeAsset(complete);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = new TextDecoder().decode(result.value);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(parseAsset(result.value)).toMatchObject({ ok: true, value: { asset: complete } });
    expect(serializeTopikJson(parseStrictTopikJson(text))).toBe(text);
  });

  test("rejects duplicate members, prototype-bearing values, and unsupported future versions", () => {
    expect(parseAsset('{"apiVersion":"v1","apiVersion":"v1"}\n')).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_DUPLICATE_MEMBER" }],
    });
    const inherited = Object.create({ type: "Asset" }) as Record<string, unknown>;
    inherited.apiVersion = "v1";
    inherited.name = "unsafe";
    inherited.spec = complete.spec;
    expect(validateAssetValue(inherited)).toMatchObject({ ok: false });
    expect(validateAssetValue({ ...complete, apiVersion: "v2" })).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_UNSUPPORTED_VERSION" }],
    });
  });

  test("rejects incomplete output, user-selected names, user metadata, and non-payload URIs", () => {
    expect(validateAssetValue({ ...complete, name: "company-logo" })).toMatchObject({ ok: false });
    expect(validateAssetValue({ ...complete, labels: { topic: "brand" } })).toMatchObject({
      ok: false,
    });
    expect(validateAssetValue({ ...complete, spec: { uri: "images/logo.png" } })).toMatchObject({
      ok: false,
    });
    expect(validateAssetValue({ ...complete, spec: { uri: complete.spec.uri } })).toMatchObject({
      ok: false,
    });
  });

  test("rejects contradictory payload digests at value, serialization, and raw parse boundaries", () => {
    const mismatched = {
      ...complete,
      spec: {
        ...complete.spec,
        integrity: `sha256:${"f".repeat(64)}`,
      },
    };
    const expected = {
      ok: false,
      diagnostics: [
        expect.objectContaining({
          id: "TOPIK_ASSET_DIGEST_MISMATCH",
          location: { jsonPointer: "/spec/integrity" },
        }),
      ],
    };

    expect(validateAssetValue(mismatched)).toMatchObject(expected);
    expect(serializeAsset(mismatched)).toMatchObject(expected);
    expect(parseAsset(serializeTopikJson(mismatched))).toMatchObject(expected);
  });

  test("enforces the portable size ceiling for runtime values and descriptors", () => {
    const maximum = {
      ...complete,
      spec: {
        ...complete.spec,
        size: TOPIK_ASSET_LIMITS.maxAssetBytes,
      },
    };
    expect(validateAssetValue(maximum)).toMatchObject({ ok: true });
    expect(parseAsset(serializeTopikJson(maximum))).toMatchObject({ ok: true });

    const oversized = {
      ...maximum,
      spec: { ...maximum.spec, size: TOPIK_ASSET_LIMITS.maxAssetBytes + 1 },
    };
    expect(validateAssetValue(oversized)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_SIZE_MISMATCH" }),
      ]),
    });
    expect(parseAsset(serializeTopikJson(oversized))).toMatchObject({ ok: false });
  });
});

describe("automatic Asset identity", () => {
  test("accepts only canonical full-SHA-256 base32 generated names", () => {
    for (const finalSymbol of BASE32_ALPHABET) {
      const name = `auto-v1-${"a".repeat(51)}${finalSymbol}`;
      const expected = finalSymbol === "a" || finalSymbol === "q";
      expect(isGeneratedAssetName(name), name).toBe(expected);
      expect(validateAssetValue({ ...complete, name }).ok, name).toBe(expected);
    }
    for (const name of [
      `auto-v1-${"a".repeat(51)}`,
      `auto-v1-${"a".repeat(53)}`,
      `auto-v1-${"a".repeat(51)}0`,
      `auto-v1-${"a".repeat(51)}A`,
      `auto-v1-${"a".repeat(52)}=`,
      `AUTO-v1-${"a".repeat(52)}`,
    ]) {
      expect(isGeneratedAssetName(name), name).toBe(false);
      expect(validateAssetValue({ ...complete, name }).ok, name).toBe(false);
    }
  });

  test("uses namespace plus normalized path, never bytes", () => {
    const first = generateAutomaticAssetName({
      stableSourceNamespace: "example-source",
      normalizedPath: "images/logo.png",
    });
    const retry = generateAutomaticAssetName({
      stableSourceNamespace: "example-source",
      normalizedPath: "images/logo.png",
    });
    const moved = generateAutomaticAssetName({
      stableSourceNamespace: "example-source",
      normalizedPath: "branding/logo.png",
    });
    const otherSource = generateAutomaticAssetName({
      stableSourceNamespace: "other-source",
      normalizedPath: "images/logo.png",
    });
    expect(first).toEqual(retry);
    expect(first.ok && first.value).toBe(
      "auto-v1-uswiemee6oksg54zvhkrggmn2cmq4gshx3mopu6f77qaq2iyewkq",
    );
    expect(moved.ok && moved.value).not.toBe(first.ok && first.value);
    expect(otherSource.ok && otherSource.value).not.toBe(first.ok && first.value);
  });

  test("rejects unstable namespaces", () => {
    expect(validateStableSourceNamespace("")).toMatchObject({ ok: false });
    expect(validateStableSourceNamespace("branch\u0000name")).toMatchObject({ ok: false });
  });

  test("normalizes namespaces before validation, sizing, and hashing", () => {
    expect(validateStableSourceNamespace("e\u0301")).toEqual({
      ok: true,
      value: "é",
      diagnostics: [],
    });
    const composed = generateAutomaticAssetName({
      stableSourceNamespace: "é",
      normalizedPath: "image.png",
    });
    const decomposed = generateAutomaticAssetName({
      stableSourceNamespace: "e\u0301",
      normalizedPath: "image.png",
    });
    expect(decomposed).toEqual(composed);
    expect(validateStableSourceNamespace("e\u0301".repeat(512))).toMatchObject({ ok: true });
    expect(validateStableSourceNamespace("e\u0301".repeat(513))).toMatchObject({ ok: false });
  });
});

describe("safe Asset diagnostics", () => {
  test.each([
    "/home/user/secret/file.bin",
    "C:\\Users\\user\\secret.bin",
    "\\\\server\\share\\secret.bin",
    "file:///home/user/secret.bin",
    "../secret.bin",
    "safe/../../secret.bin",
    "／home／user／secret.bin",
    "safe\u0000/secret.bin",
  ])("redacts private or ambiguous diagnostic path %s", (path) => {
    expect(
      topikAssetDiagnostic("TOPIK_ASSET_FILE_MISSING", "Asset file is missing", {
        location: { path },
        reason: "absolute",
      }),
    ).toMatchObject({
      location: { path: "[redacted]" },
      reason: "absolute",
      message: "Asset file is missing",
    });
  });

  test("preserves a canonical relative diagnostic path and stable reason", () => {
    expect(
      topikAssetDiagnostic("TOPIK_ASSET_FILE_MISSING", "Asset file is missing", {
        location: { path: "assets/manual.bin" },
        reason: "forbidden_character",
      }),
    ).toMatchObject({
      location: { path: "assets/manual.bin" },
      reason: "forbidden_character",
    });
  });
});

describe("active-content sniff boundary", () => {
  test.each([
    ["HTML", "<html><body>x</body></html>", "text/html"],
    ["HTML comment", "<!-- generated --><html><body>x</body></html>", "text/html"],
    ["HTML doctype", "<!DOCTYPE html><title>x</title>", "text/html"],
    ["SVG", '<svg xmlns="http://www.w3.org/2000/svg" />', "image/svg+xml"],
    ["XML-prefixed SVG", '<?xml version="1.0"?><svg />', "image/svg+xml"],
    ["script", "<script>alert(1)</script>", "text/html"],
    ["Unix executable", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]), "application/x-executable"],
    ["WebAssembly", Uint8Array.from([0x00, 0x61, 0x73, 0x6d]), "application/wasm"],
  ])("detects active %s bytes", (_name, source, expected) => {
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
    expect(sniffPortableMediaType(bytes)).toBe(expected);
  });

  test.each(["<svg", "<!--", "<!doctype html", "<?xml"])(
    "fails closed for every UTF-8 split before %s",
    (opener) => {
      const whitespace = new TextEncoder().encode("\u3000");
      for (let split = 1; split < whitespace.byteLength; split++) {
        const prefix = new Uint8Array(64 * 1024 - split);
        prefix.fill(0x20);
        const bytes = Buffer.concat([prefix, whitespace, Buffer.from(opener)]);
        expect(sniffPortableMediaType(bytes)).toBe(TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE);
      }
    },
  );

  test("keeps bounded opaque bytes downloadable", () => {
    expect(sniffPortableMediaType(new TextEncoder().encode("ordinary opaque bytes"))).toBe(
      "application/octet-stream",
    );
    expect(sniffPortableMediaType(Uint8Array.from([0x80, 0x00, 0x01, 0x02]))).toBe(
      "application/octet-stream",
    );
  });
});
