import { describe, expect, test } from "vite-plus/test";
import type { Asset } from "@topik/schema";
import {
  generateImplicitAssetName,
  parseAsset,
  serializeAsset,
  validateAssetValue,
  validateStableSourceNamespace,
} from "./asset";
import { parseStrictTopikJson, serializeTopikJson } from "./json";
import { sniffPortableMediaType, TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE } from "./media";

const complete: Asset = {
  apiVersion: "v1",
  type: "Asset",
  name: "company-logo",
  labels: { topic: "brand" },
  spec: {
    uri: "images/logo.png",
    integrity: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    size: 7,
    mediaType: "image/png",
    license: { spdxExpression: "MIT" },
    attribution: { text: "Logo by Example" },
  },
};

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
    inherited.spec = { uri: "file.bin" };
    expect(validateAssetValue(inherited)).toMatchObject({ ok: false });
    expect(validateAssetValue({ ...complete, apiVersion: "v2" })).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_UNSUPPORTED_VERSION" }],
    });
  });

  test("requires exact facts for immutable remote URIs and rejects signed or fragmented URLs", () => {
    expect(
      validateAssetValue({ ...complete, spec: { uri: "https://cdn.example.com/rev.png" } }),
    ).toMatchObject({ ok: false });
    expect(
      validateAssetValue({
        ...complete,
        spec: { ...complete.spec, uri: "https://cdn.example.com/rev.png?token=x" },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateAssetValue({
        ...complete,
        spec: { ...complete.spec, uri: "https://cdn.example.com/rev.png#x" },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("implicit Asset identity", () => {
  test("uses namespace plus normalized path, never bytes", () => {
    const first = generateImplicitAssetName({
      stableSourceNamespace: "example-source",
      normalizedPath: "images/logo.png",
    });
    const retry = generateImplicitAssetName({
      stableSourceNamespace: "example-source",
      normalizedPath: "images/logo.png",
    });
    const moved = generateImplicitAssetName({
      stableSourceNamespace: "example-source",
      normalizedPath: "branding/logo.png",
    });
    const otherSource = generateImplicitAssetName({
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
    expect(validateStableSourceNamespace("e\u0301")).toMatchObject({ ok: false });
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
