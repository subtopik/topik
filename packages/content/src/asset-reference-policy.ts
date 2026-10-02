export const TOPIK_ASSET_REFERENCE_VERSION = "topik-asset-reference-v1" as const;
const TOPIK_GENERATED_ASSET_NAME_VALIDATOR = /^auto-v1-[a-z2-7]{51}[aq]$/u;

/** Public grammar descriptor. Runtime admission uses an isolated boundary. */
export const TOPIK_GENERATED_ASSET_NAME_PATTERN = /^auto-v1-[a-z2-7]{51}[aq]$/u;

declare const topikGeneratedAssetNameBrand: unique symbol;

/** Compiler-generated name used by the compiled-content Asset reference protocol. */
export type TopikGeneratedAssetName = string & {
  readonly [topikGeneratedAssetNameBrand]: "TopikGeneratedAssetName";
};

export function isTopikGeneratedAssetName(value: unknown): value is TopikGeneratedAssetName {
  return typeof value === "string" && TOPIK_GENERATED_ASSET_NAME_VALIDATOR.test(value);
}

export function parseTopikGeneratedAssetName(value: string): TopikGeneratedAssetName {
  if (!isTopikGeneratedAssetName(value)) {
    throw new TypeError("Generated Asset name is not canonical");
  }
  return value;
}

export type TopikAssetReferenceValidation =
  | { valid: true; kind: "asset"; name: TopikGeneratedAssetName }
  | { valid: true; kind: "local"; decodedPath: string }
  | { valid: true; kind: "external-https" }
  | { valid: false; kind: "unsafe"; failureKind: "local" | "external" };

/** Validate the URL-facing portion of topik-asset-reference-v1 without filesystem access. */
export function validateTopikAssetReference(reference: string): TopikAssetReferenceValidation {
  if (containsUnsafeUnicode(reference) || reference.includes("\\")) {
    return unsafe(reference);
  }
  if (reference.startsWith("asset:")) {
    const name = reference.slice("asset:".length);
    return isTopikGeneratedAssetName(name)
      ? { valid: true, kind: "asset", name }
      : { valid: false, kind: "unsafe", failureKind: "local" };
  }
  if (/^https:\/\//iu.test(reference)) {
    try {
      const url = new URL(reference);
      return url.protocol === "https:" && url.username === "" && url.password === ""
        ? { valid: true, kind: "external-https" }
        : { valid: false, kind: "unsafe", failureKind: "external" };
    } catch {
      return { valid: false, kind: "unsafe", failureKind: "external" };
    }
  }
  if (reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    return { valid: false, kind: "unsafe", failureKind: "external" };
  }
  if (
    reference.length === 0 ||
    reference.startsWith("/") ||
    reference.includes("?") ||
    reference.includes("#") ||
    containsNonAscii(reference)
  ) {
    return { valid: false, kind: "unsafe", failureKind: "local" };
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
        return { valid: false, kind: "unsafe", failureKind: "local" };
      }
      const byte = Number.parseInt(pair, 16);
      if (byte === 0x2f || byte === 0x5c || byte === 0x25) {
        return { valid: false, kind: "unsafe", failureKind: "local" };
      }
      bytes.push(byte);
      index += 2;
      continue;
    }
    if (!/^[A-Za-z0-9._~-]$/u.test(character)) {
      return { valid: false, kind: "unsafe", failureKind: "local" };
    }
    bytes.push(character.charCodeAt(0));
  }

  let decodedPath: string;
  try {
    decodedPath = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return { valid: false, kind: "unsafe", failureKind: "local" };
  }
  if (!isSafeDecodedPath(decodedPath) || encodeLocalPath(decodedPath) !== reference) {
    return { valid: false, kind: "unsafe", failureKind: "local" };
  }
  return { valid: true, kind: "local", decodedPath };
}

function unsafe(reference: string): TopikAssetReferenceValidation {
  return {
    valid: false,
    kind: "unsafe",
    failureKind:
      reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference) ? "external" : "local",
  };
}

function isSafeDecodedPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    path.normalize("NFC") !== path ||
    containsUnsafeUnicode(path) ||
    /[<>:"|?*]/u.test(path)
  ) {
    return false;
  }
  const components = path.split("/");
  return components.every(
    (component) =>
      component.length > 0 &&
      (component === "." || component === ".." || !/[. ]$/u.test(component)),
  );
}

function encodeLocalPath(path: string): string {
  const encoder = new TextEncoder();
  return path
    .split("/")
    .map((component) =>
      [...encoder.encode(component)]
        .map((byte) => {
          const character = String.fromCharCode(byte);
          return /^[A-Za-z0-9._~-]$/u.test(character)
            ? character
            : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        })
        .join(""),
    )
    .join("/");
}

function containsUnsafeUnicode(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Noncharacter_Code_Point}]/u.test(
    value,
  );
}

function containsNonAscii(value: string): boolean {
  for (const character of value) if ((character.codePointAt(0) ?? 0) > 0x7f) return true;
  return false;
}
