import { TOPIK_ASSET_REFERENCE_VERSION } from "./constants";
import { topikAssetDiagnostic, type TopikAssetResult } from "./diagnostics";
import { validateTopikPath, type ValidateTopikPathOptions } from "./path";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UNRESERVED = /^[A-Za-z0-9._~-]$/u;

export function encodeTopikAssetReference(
  path: string,
  options: ValidateTopikPathOptions = {},
): TopikAssetResult<string> {
  const valid = validateTopikPath(path, options);
  if (!valid.ok) return { ok: false, diagnostics: valid.diagnostics };
  const encoded = path
    .split("/")
    .map((component) => {
      let result = "";
      for (const byte of encoder.encode(component)) {
        const character = String.fromCharCode(byte);
        result += UNRESERVED.test(character)
          ? character
          : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
      return result;
    })
    .join("/");
  return { ok: true, value: encoded, diagnostics: [] };
}

export function decodeTopikAssetReference(
  reference: string,
  options: ValidateTopikPathOptions = {},
): TopikAssetResult<string> {
  if (
    reference.length === 0 ||
    reference.startsWith("/") ||
    reference.startsWith("//") ||
    reference.includes("?") ||
    reference.includes("#") ||
    containsNonAscii(reference) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(reference)
  ) {
    return referenceFailure(reference, "Local asset reference has a forbidden URL form");
  }

  const bytes: number[] = [];
  for (let index = 0; index < reference.length; index++) {
    const character = reference[index];
    if (character === "/") {
      bytes.push(0x2f);
      continue;
    }
    if (character === "%") {
      const pair = reference.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/u.test(pair)) {
        return referenceFailure(
          reference,
          "Percent escapes must use two uppercase hexadecimal digits",
        );
      }
      const byte = Number.parseInt(pair, 16);
      if (byte === 0x2f || byte === 0x5c || byte === 0x25) {
        return referenceFailure(reference, "Encoded separators and percent signs are not allowed");
      }
      bytes.push(byte);
      index += 2;
      continue;
    }
    if (!UNRESERVED.test(character)) {
      return referenceFailure(reference, "Reference contains a noncanonical raw byte");
    }
    bytes.push(character.charCodeAt(0));
  }

  let decoded: string;
  try {
    decoded = decoder.decode(Uint8Array.from(bytes));
  } catch {
    return referenceFailure(reference, "Reference percent escapes are not strict UTF-8");
  }
  if (decoded.includes("%")) {
    return referenceFailure(reference, "Decoded percent signs are not allowed");
  }
  const valid = validateTopikPath(decoded, options);
  if (!valid.ok) return { ok: false, diagnostics: valid.diagnostics };
  const reencoded = encodeTopikAssetReference(decoded, options);
  if (!reencoded.ok || reencoded.value !== reference) {
    return referenceFailure(reference, "Reference is not in canonical encoded form");
  }
  return { ok: true, value: decoded, diagnostics: [] };
}

export function validateTopikExternalAssetReference(reference: string): TopikAssetResult<string> {
  if (containsControl(reference) || reference.includes("\\")) {
    return externalFailure(reference, "External reference contains controls");
  }
  try {
    const url = new URL(reference);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !reference.startsWith("https://")
    ) {
      return externalFailure(reference, "External asset references require credential-free HTTPS");
    }
    return { ok: true, value: reference, diagnostics: [] };
  } catch {
    return externalFailure(reference, "External asset reference is not a valid absolute HTTPS URL");
  }
}

function referenceFailure(reference: string, message: string): TopikAssetResult<string> {
  return {
    ok: false,
    source: encoder.encode(reference),
    diagnostics: [
      topikAssetDiagnostic("TOPIK_ASSET_PATH_INVALID", message, {
        descriptorVersion: TOPIK_ASSET_REFERENCE_VERSION,
        location: { path: "[redacted-invalid-reference]" },
        reason: "percent_noncanonical",
      }),
    ],
  };
}

function externalFailure(reference: string, message: string): TopikAssetResult<string> {
  return {
    ok: false,
    source: encoder.encode(reference),
    diagnostics: [
      topikAssetDiagnostic("TOPIK_EXTERNAL_REFERENCE_UNSAFE", message, {
        descriptorVersion: TOPIK_ASSET_REFERENCE_VERSION,
        location: { path: "[redacted-external-reference]" },
        recovery: "preserve-read-only",
      }),
    ],
  };
}

function isControl(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function containsControl(value: string): boolean {
  for (const character of value) if (isControl(character)) return true;
  return false;
}

function containsNonAscii(value: string): boolean {
  for (const character of value) if ((character.codePointAt(0) ?? 0) > 0x7f) return true;
  return false;
}
