import { describe, expect, test } from "vite-plus/test";
import {
  TOPIK_ASSET_DEFAULT_CORRELATION_ID,
  TOPIK_PATH_V1_DESCRIPTOR,
  computeTopikPathCollisionKey,
  correlateTopikAssetResult,
  decodeTopikAssetReference,
  encodeTopikAssetReference,
  generateTopikAssetKey,
  validateTopikExternalAssetReference,
  validateTopikPath,
  validateTopikPathSet,
} from "./index";

describe("portable asset keys", () => {
  test("encodes deterministic injected 128-bit entropy vectors", () => {
    expect(generateTopikAssetKey({ randomBytes: () => new Uint8Array(16) })).toMatchObject({
      ok: true,
      value: "ast_00000000000000000000000000",
    });
    expect(
      generateTopikAssetKey({ randomBytes: () => new Uint8Array(16).fill(255) }),
    ).toMatchObject({
      ok: true,
      value: "ast_7zzzzzzzzzzzzzzzzzzzzzzzzz",
    });
  });

  test("uses CSPRNG by default, reuses retry keys, and never selects retired keys", () => {
    const generated = generateTopikAssetKey();
    expect(generated.ok && generated.value).toMatch(/^ast_[0-7][0-9a-hjkmnp-tv-z]{25}$/u);
    const persisted = "ast_00000000000000000000000000";
    expect(
      generateTopikAssetKey({ persistedKey: persisted, reservedKeys: [persisted] }),
    ).toMatchObject({ ok: true, value: persisted });
    expect(
      generateTopikAssetKey({ persistedKey: persisted, retiredKeys: [persisted] }),
    ).toMatchObject({ ok: false, diagnostics: [{ id: "TOPIK_ASSET_KEY_INVALID" }] });
    let call = 0;
    const collisionThenNew = generateTopikAssetKey({
      retiredKeys: [persisted],
      randomBytes: () => (call++ === 0 ? new Uint8Array(16) : new Uint8Array(16).fill(1)),
    });
    expect(collisionThenNew.ok && collisionThenNew.value).not.toBe(persisted);
    expect(call).toBe(2);
  });
});

describe("topik-path-v1", () => {
  test("pins and checks Unicode 17 while preserving accepted storage spelling", () => {
    expect(TOPIK_PATH_V1_DESCRIPTOR.unicodeVersion).toBe("17.0.0");
    expect(process.versions.unicode).toBe("17.0");
    expect(validateTopikPath("Café/Photo.png")).toMatchObject({
      ok: true,
      value: { path: "Café/Photo.png" },
    });
    expect(validateTopikPath("Cafe\u0301/Photo.png")).toMatchObject({
      ok: false,
      diagnostics: [{ reason: "not_nfc" }],
    });
  });

  test("uses full NFKC casefold collision forms", () => {
    expect(computeTopikPathCollisionKey("Straße.png")).toMatchObject({
      ok: true,
      value: "strasse.png",
    });
    expect(validateTopikPathSet(["Straße.png", "STRASSE.png"])).toMatchObject({
      ok: false,
      diagnostics: [{ id: "TOPIK_ASSET_PATH_COLLISION" }],
    });
    expect(validateTopikPathSet(["ΟΣ.png", "οσ.png"])).toMatchObject({ ok: false });
    expect(validateTopikPathSet(["Ꭰ.png", "ꭰ.png"])).toMatchObject({ ok: false });
    expect(validateTopikPathSet(["a", "a/b"])).toMatchObject({ ok: false });
  });

  test.each([
    ["slash alias", "a∕b.png", "separator_alias"],
    ["git control", ".Git/config", "reserved_name"],
    ["git short name", "git~1", "reserved_name"],
    ["Topik control", "assets/.TOPIK/a", "reserved_name"],
    ["DOS name", "CON.txt", "reserved_name"],
    ["compatibility digit", "com¹.txt", "reserved_name"],
    ["trailing dot", "file.", "forbidden_character"],
    ["bidi", "a\u202eb", "forbidden_character"],
  ])("rejects %s", (_name, path, reason) => {
    expect(validateTopikPath(path)).toMatchObject({ ok: false, diagnostics: [{ reason }] });
  });

  test("enforces component, count, and complete repository byte boundaries", () => {
    expect(validateTopikPath("a".repeat(255))).toMatchObject({ ok: true });
    expect(validateTopikPath("a".repeat(256))).toMatchObject({ ok: false });
    expect(validateTopikPath(Array.from({ length: 64 }, () => "a").join("/"))).toMatchObject({
      ok: true,
    });
    expect(validateTopikPath(Array.from({ length: 65 }, () => "a").join("/"))).toMatchObject({
      ok: false,
    });
    expect(validateTopikPath("asset.bin", { bindingRoot: "b".repeat(760) })).toMatchObject({
      ok: false,
    });
  });

  test("cannot weaken portable path maxima with caller-crafted capabilities", () => {
    const capabilities = {
      maxComponentUtf8Bytes: 10_000,
      maxComponents: 1_000,
      maxRepositoryPathUtf8Bytes: 100_000,
    };
    expect(validateTopikPath("a".repeat(256), { capabilities })).toMatchObject({ ok: false });
    expect(
      validateTopikPath(Array.from({ length: 65 }, () => "a").join("/"), { capabilities }),
    ).toMatchObject({ ok: false });
    expect(
      validateTopikPath("asset.bin", { bindingRoot: "b".repeat(760), capabilities }),
    ).toMatchObject({ ok: false });
  });

  test("carries a safe default correlation ID and supports explicit operation correlation", () => {
    const invalid = validateTopikPath("../secret");
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.diagnostics[0].correlationId).toBe(TOPIK_ASSET_DEFAULT_CORRELATION_ID);

    const correlationId = "cor_00000000000000000000000001" as const;
    expect(correlateTopikAssetResult(invalid, correlationId)).toMatchObject({
      ok: false,
      diagnostics: [{ correlationId }],
    });
    expect(() => correlateTopikAssetResult(invalid, "cor_host-secret" as never)).toThrow(
      /Correlation ID/u,
    );
  });

  test("preserves advertised lower path limits", () => {
    expect(validateTopikPath("a/b", { capabilities: { maxComponents: 1 } })).toMatchObject({
      ok: false,
    });
    expect(validateTopikPath("abcd", { capabilities: { maxComponentUtf8Bytes: 3 } })).toMatchObject(
      {
        ok: false,
      },
    );
  });
});

describe("topik-asset-reference-v1", () => {
  test("encodes only non-unreserved UTF-8 bytes with uppercase escapes", () => {
    expect(encodeTopikAssetReference("images/Café image.png")).toMatchObject({
      ok: true,
      value: "images/Caf%C3%A9%20image.png",
    });
    expect(decodeTopikAssetReference("images/Caf%C3%A9%20image.png")).toMatchObject({
      ok: true,
      value: "images/Café image.png",
    });
  });

  test.each([
    "images/caf%c3%a9.png",
    "images/café.png",
    "%2E%2E/secret.png",
    "images%2Fsecret.png",
    "images%5Csecret.png",
    "images/%252E.png",
    "https://example.com/x.png",
    "/images/x.png",
    "images/x.png?q=1",
  ])("rejects noncanonical or unsafe local reference %s", (reference) => {
    expect(decodeTopikAssetReference(reference)).toMatchObject({ ok: false });
  });

  test("preserves exact safe external HTTPS URLs and rejects unsafe forms", () => {
    const exact = "https://example.com/a.png?token=public#hero";
    expect(validateTopikExternalAssetReference(exact)).toMatchObject({ ok: true, value: exact });
    for (const unsafe of [
      "http://example.com/a.png",
      "//example.com/a.png",
      "https://user:pass@example.com/a.png",
      "https://example.com\\evil.png",
      "javascript:alert(1)",
      "https://example.com/a\u0000.png",
    ]) {
      expect(validateTopikExternalAssetReference(unsafe)).toMatchObject({ ok: false });
    }
  });

  test("keeps credential-bearing and control-bearing references out of diagnostics", () => {
    const reference = "https://user:secret@example.com/a.png?token=signed-secret\u001b\u202e";
    const result = validateTopikExternalAssetReference(reference);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const strings = diagnosticStrings(result.diagnostics);
    for (const value of strings) {
      expect(value).not.toContain("secret");
      expect(value).not.toContain("signed-secret");
      expect(value).not.toMatch(/[\p{Cc}\p{Bidi_Control}]/u);
    }
    expect(result.source).toEqual(new TextEncoder().encode(reference));
  });
});

function diagnosticStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(diagnosticStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(diagnosticStrings);
  }
  return [];
}
