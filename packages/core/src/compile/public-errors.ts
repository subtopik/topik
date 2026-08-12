import { isAbsolute, posix, win32 } from "node:path";
import { isTopikPathCodePointForbiddenV17 } from "../assets/path-unicode-v17";

const PUBLIC_COMPILE_ERROR_MESSAGES = {
  "config-access-failed": "Configuration file could not be accessed.",
  "config-invalid": "Configuration is invalid.",
  "config-not-found": "Required configuration file was not found.",
  "config-parse-failed": "Configuration file could not be parsed.",
  "config-read-failed": "Configuration file could not be read safely.",
  "file-not-regular": "Compilation input must be a regular file.",
  "file-outside-compilation-root": "Compilation input resolves outside the source root.",
  "frontmatter-invalid": "Document frontmatter is invalid.",
  "reference-list-invalid": "Document resource references are invalid.",
  "wiki-page-not-found": "A configured Wiki page file was not found.",
} as const;

export type PublicCompileErrorId = keyof typeof PUBLIC_COMPILE_ERROR_MESSAGES;

export function publicCompileErrorMessage(id: unknown): string | undefined {
  return typeof id === "string" && Object.hasOwn(PUBLIC_COMPILE_ERROR_MESSAGES, id)
    ? PUBLIC_COMPILE_ERROR_MESSAGES[id as PublicCompileErrorId]
    : undefined;
}

/** Public compiler failure with fixed wording, stable ID, and optional safe relative location. */
export class PublicCompileError extends Error {
  public readonly id: PublicCompileErrorId;
  public readonly location?: string;

  constructor(id: PublicCompileErrorId, location?: string) {
    super(publicCompileErrorMessage(id) ?? "Compilation failed.");
    this.name = "PublicCompileError";
    this.id = id;
    const safeLocation = sanitizeCompileLocation(location);
    if (safeLocation !== undefined) this.location = safeLocation;
  }
}

function sanitizeCompileLocation(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 768) return undefined;
  if (isAbsolute(value) || win32.isAbsolute(value)) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const components = normalized.split("/");
  if (
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    ) ||
    containsForbiddenCodePoint(normalized) ||
    /[?#:@%]/u.test(normalized)
  ) {
    return undefined;
  }
  return posix.normalize(normalized);
}

function containsForbiddenCodePoint(value: string): boolean {
  for (const character of value) {
    if (isTopikPathCodePointForbiddenV17(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}
