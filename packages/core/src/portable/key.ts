import { randomBytes as secureRandomBytes } from "node:crypto";
import { TOPIK_PATH_VERSION } from "./constants";
import { topikAssetDiagnostic, type TopikAssetResult } from "./diagnostics";

const CROCKFORD_LOWERCASE = "0123456789abcdefghjkmnpqrstvwxyz";
export const TOPIK_ASSET_KEY_PATTERN = /^ast_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export interface GenerateTopikAssetKeyOptions {
  /** A key already persisted for this logical operation; retries always reuse it. */
  persistedKey?: string;
  /** All live keys in the resource history. */
  reservedKeys?: Iterable<string>;
  /** Retired/deleted keys remain permanently reserved. */
  retiredKeys?: Iterable<string>;
  /** Test seam. Production callers omit this to use Node's CSPRNG. */
  randomBytes?: (size: number) => Uint8Array;
  maxAttempts?: number;
}

export function generateTopikAssetKey(
  options: GenerateTopikAssetKeyOptions = {},
): TopikAssetResult<string> {
  const unavailable = new Set([...(options.reservedKeys ?? []), ...(options.retiredKeys ?? [])]);
  if (options.persistedKey !== undefined) {
    if (!TOPIK_ASSET_KEY_PATTERN.test(options.persistedKey)) {
      return invalidKey(options.persistedKey, "Persisted portable asset key has invalid grammar");
    }
    if (new Set(options.retiredKeys ?? []).has(options.persistedKey)) {
      return invalidKey(options.persistedKey, "A retired portable asset key cannot be reused");
    }
    return { ok: true, value: options.persistedKey, diagnostics: [] };
  }

  const entropy = options.randomBytes ?? ((size: number) => secureRandomBytes(size));
  const attempts = options.maxAttempts ?? 128;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const bytes = entropy(16);
    if (bytes.byteLength !== 16) {
      return invalidKey(
        undefined,
        "Portable asset key entropy source must return exactly 16 bytes",
      );
    }
    const key = encodeKey(bytes);
    if (!unavailable.has(key)) return { ok: true, value: key, diagnostics: [] };
  }
  return invalidKey(undefined, "Could not allocate an unused portable asset key");
}

export function isTopikAssetKey(value: string): boolean {
  return TOPIK_ASSET_KEY_PATTERN.test(value);
}

function encodeKey(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  do {
    encoded = CROCKFORD_LOWERCASE[Number(value & 31n)] + encoded;
    value >>= 5n;
  } while (value > 0n);
  return `ast_${encoded.padStart(26, "0")}`;
}

function invalidKey(key: string | undefined, message: string): TopikAssetResult<string> {
  return {
    ok: false,
    diagnostics: [
      topikAssetDiagnostic("TOPIK_ASSET_KEY_INVALID", message, {
        descriptorVersion: TOPIK_PATH_VERSION,
        location: key === undefined ? {} : { key: "[redacted-invalid-key]" },
      }),
    ],
  };
}
