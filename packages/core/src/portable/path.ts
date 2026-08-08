import { TOPIK_PATH_V1_DESCRIPTOR, TOPIK_PATH_VERSION } from "./constants";
import { NFKC_CASEFOLD_V17_DATA } from "./nfkc-casefold-v17";
import {
  topikAssetDiagnostic,
  type TopikAssetDiagnostic,
  type TopikAssetPathDiagnosticReason,
  type TopikAssetResult,
} from "./diagnostics";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_ASCII = /[\\%<>:"|?*]/u;
const FORBIDDEN_CATEGORY = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const FORBIDDEN_WHITESPACE = /[\p{White_Space}&&[^ ]]/v;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const BIDI_CONTROL = /\p{Bidi_Control}/u;
const NONCHARACTER = /\p{Noncharacter_Code_Point}/u;
const SEPARATOR_ALIASES = /[\u2044\u2215\u29f5\u29f8\u29f9\ufe68\uff0f\uff3c]/u;
const DOS_STEM = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])$/u;
const NFKC_CASEFOLD_V17 = parseNfkcCasefoldData(NFKC_CASEFOLD_V17_DATA);

export interface ValidateTopikPathOptions {
  bindingRoot?: string;
  allowControlSidecar?: boolean;
  capabilities?: {
    maxComponentUtf8Bytes?: number;
    maxComponents?: number;
    maxRepositoryPathUtf8Bytes?: number;
  };
}

export interface ValidTopikPath {
  path: string;
  collisionKey: string;
  utf8Bytes: number;
}

export function validateTopikPath(
  input: string | Uint8Array,
  options: ValidateTopikPathOptions = {},
): TopikAssetResult<ValidTopikPath> {
  let path: string;
  try {
    path = typeof input === "string" ? input : decoder.decode(input);
  } catch {
    return pathFailure("", "invalid_utf8", "Path is not strict UTF-8");
  }

  if (!validPathCapabilities(options.capabilities)) {
    return pathFailure(
      path,
      "capability_invalid",
      "Path capabilities must stay within immutable portable maxima",
    );
  }

  if (
    normalizeUnicodeVersion(process.versions.unicode ?? "") !==
    TOPIK_PATH_V1_DESCRIPTOR.unicodeVersion
  ) {
    return pathFailure(
      path,
      "unicode_version_unsupported",
      `topik-path-v1 requires Unicode ${TOPIK_PATH_V1_DESCRIPTOR.unicodeVersion}`,
    );
  }
  if (path.length === 0 || path.includes("\u0000") || path.includes("\ufeff")) {
    return pathFailure(path, "forbidden_character", "Path is empty or contains a forbidden value");
  }
  if (
    path.startsWith("/") ||
    path.startsWith("//") ||
    /^[a-z]:/iu.test(path) ||
    path.startsWith("\\\\") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(path)
  ) {
    return pathFailure(path, "absolute", "Path must be repository relative");
  }
  if (FORBIDDEN_ASCII.test(path)) {
    return pathFailure(path, "forbidden_character", "Path contains a forbidden character");
  }
  if (SEPARATOR_ALIASES.test(path)) {
    return pathFailure(path, "separator_alias", "Path contains a separator-confusable character");
  }
  if (
    FORBIDDEN_CATEGORY.test(path) ||
    FORBIDDEN_WHITESPACE.test(path) ||
    DEFAULT_IGNORABLE.test(path) ||
    BIDI_CONTROL.test(path) ||
    NONCHARACTER.test(path)
  ) {
    return pathFailure(path, "forbidden_character", "Path contains a forbidden Unicode value");
  }
  if (path.normalize("NFC") !== path) {
    return pathFailure(path, "not_nfc", "Path must already be in NFC storage spelling");
  }

  const components = path.split("/");
  if (components.some((component) => component.length === 0)) {
    return pathFailure(path, "separator_alias", "Path contains an empty component");
  }
  if (components.some((component) => component === "." || component === "..")) {
    return pathFailure(path, "dot_segment", "Path contains a dot segment");
  }

  const maxComponents =
    options.capabilities?.maxComponents ?? TOPIK_PATH_V1_DESCRIPTOR.maxComponents;
  if (components.length > maxComponents) {
    return pathFailure(path, "too_long", "Path has too many components");
  }

  const collisionComponents: string[] = [];
  for (const component of components) {
    if (component.startsWith(" ") || component.endsWith(" ") || component.endsWith(".")) {
      return pathFailure(path, "forbidden_character", "Path component has unsafe edge spelling");
    }
    const maxComponentBytes =
      options.capabilities?.maxComponentUtf8Bytes ?? TOPIK_PATH_V1_DESCRIPTOR.maxComponentUtf8Bytes;
    if (encoder.encode(component).byteLength > maxComponentBytes) {
      return pathFailure(path, "too_long", "Path component exceeds the UTF-8 byte limit");
    }
    const collision = toNfkcCasefold(component);
    if (
      collision.length === 0 ||
      collision === "." ||
      collision === ".." ||
      collision.includes("/") ||
      collision.includes("\\")
    ) {
      return pathFailure(path, "separator_alias", "Path component folds to an unsafe spelling");
    }
    const stem = collision.replace(/[ .]+$/u, "").split(".", 1)[0];
    if (
      DOS_STEM.test(stem) ||
      collision === ".git" ||
      /^git~[1-9][0-9]*$/u.test(collision) ||
      (collision === ".topik" && !options.allowControlSidecar)
    ) {
      return pathFailure(path, "reserved_name", "Path contains a reserved component");
    }
    collisionComponents.push(collision);
  }

  if (options.allowControlSidecar && path !== ".topik/assets.json") {
    return pathFailure(path, "reserved_name", "Only the exact Topik control sidecar is allowed");
  }

  const repositoryPath = options.bindingRoot ? `${options.bindingRoot}/${path}` : path;
  const maxRepositoryBytes =
    options.capabilities?.maxRepositoryPathUtf8Bytes ??
    TOPIK_PATH_V1_DESCRIPTOR.maxRepositoryPathUtf8Bytes;
  if (encoder.encode(repositoryPath).byteLength > maxRepositoryBytes) {
    return pathFailure(path, "too_long", "Complete repository path exceeds the UTF-8 byte limit");
  }

  return {
    ok: true,
    value: {
      path,
      collisionKey: collisionComponents.join("/"),
      utf8Bytes: encoder.encode(path).length,
    },
    diagnostics: [],
  };
}

function validPathCapabilities(capabilities: ValidateTopikPathOptions["capabilities"]): boolean {
  if (capabilities === undefined) return true;
  return (
    validOptionalLimit(
      capabilities.maxComponentUtf8Bytes,
      TOPIK_PATH_V1_DESCRIPTOR.maxComponentUtf8Bytes,
    ) &&
    validOptionalLimit(capabilities.maxComponents, TOPIK_PATH_V1_DESCRIPTOR.maxComponents) &&
    validOptionalLimit(
      capabilities.maxRepositoryPathUtf8Bytes,
      TOPIK_PATH_V1_DESCRIPTOR.maxRepositoryPathUtf8Bytes,
    )
  );
}

function validOptionalLimit(value: number | undefined, maximum: number): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 1 && value <= maximum);
}

export function computeTopikPathCollisionKey(
  path: string,
  options: ValidateTopikPathOptions = {},
): TopikAssetResult<string> {
  const result = validateTopikPath(path, options);
  return result.ok
    ? { ok: true, value: result.value.collisionKey, diagnostics: [] }
    : { ok: false, diagnostics: result.diagnostics };
}

export function validateTopikPathSet(
  paths: readonly string[],
  options: ValidateTopikPathOptions = {},
): TopikAssetResult<Map<string, string>> {
  const byCollision = new Map<string, string>();
  const diagnostics: TopikAssetDiagnostic[] = [];
  for (const path of paths) {
    const result = validateTopikPath(path, options);
    if (!result.ok) {
      diagnostics.push(...result.diagnostics);
      continue;
    }
    const existing = byCollision.get(result.value.collisionKey);
    if (existing !== undefined && existing !== path) {
      diagnostics.push(
        topikAssetDiagnostic("TOPIK_ASSET_PATH_COLLISION", "Paths have the same collision key", {
          descriptorVersion: TOPIK_PATH_VERSION,
          location: { path },
          reason: "casefold_collision",
        }),
      );
    } else {
      byCollision.set(result.value.collisionKey, path);
    }
  }
  for (const child of byCollision.keys()) {
    const components = child.split("/");
    for (let count = 1; count < components.length; count++) {
      if (!byCollision.has(components.slice(0, count).join("/"))) continue;
      diagnostics.push(
        topikAssetDiagnostic(
          "TOPIK_ASSET_PATH_COLLISION",
          "A portable file path cannot also be another file's parent",
          {
            descriptorVersion: TOPIK_PATH_VERSION,
            location: { path: byCollision.get(child) },
            reason: "casefold_collision",
          },
        ),
      );
      break;
    }
  }
  return diagnostics.length === 0
    ? { ok: true, value: byCollision, diagnostics: [] }
    : { ok: false, value: byCollision, diagnostics };
}

/** Unicode 17 NFKC casefold. The runtime version is guarded before this is used. */
export function toNfkcCasefold(value: string): string {
  let mapped = "";
  for (const character of value) {
    mapped += NFKC_CASEFOLD_V17.get(character.codePointAt(0) ?? 0) ?? character;
  }
  return mapped.normalize("NFC");
}

function pathFailure(
  path: string,
  reason: TopikAssetPathDiagnosticReason,
  message: string,
): TopikAssetResult<ValidTopikPath> {
  return {
    ok: false,
    diagnostics: [
      topikAssetDiagnostic("TOPIK_ASSET_PATH_INVALID", message, {
        descriptorVersion: TOPIK_PATH_VERSION,
        location: { path: safePath(path) },
        reason,
      }),
    ],
  };
}

function safePath(path: string): string {
  return JSON.stringify(path).slice(1, -1);
}

function normalizeUnicodeVersion(version: string): string {
  const parts = version.split(".");
  return [...parts, ...Array.from({ length: Math.max(0, 3 - parts.length) }, () => "0")]
    .slice(0, 3)
    .join(".");
}

function parseNfkcCasefoldData(source: string): ReadonlyMap<number, string> {
  const mapping = new Map<number, string>();
  const records = source
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("")
    .split(";")
    .filter(Boolean);
  for (const record of records) {
    const [range, encoded = ""] = record.split("=");
    const [startValue, endValue = startValue] = range.split("..");
    const start = Number.parseInt(startValue, 16);
    const end = Number.parseInt(endValue, 16);
    const replacement = encoded
      .split(".")
      .filter(Boolean)
      .map((value) => String.fromCodePoint(Number.parseInt(value, 16)))
      .join("");
    for (let codePoint = start; codePoint <= end; codePoint++) {
      mapping.set(codePoint, replacement);
    }
  }
  return mapping;
}
