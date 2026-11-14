import { isAbsolute, posix, win32 } from "node:path";
import { isTopikPathCodePointForbiddenV17 } from "../assets/path-unicode-v17";

const PUBLIC_COMPILE_ERROR_MESSAGES = {
  "manifest-required":
    'Project compilation requires .topik.yaml in the selected directory. Add a manifest such as: {"version":1,"namespace":"owner/project","sources":[{"kind":"wiki","config":"wiki.yaml"}]}',
  "manifest-invalid": "Root manifest is invalid.",
  "manifest-source-failed": "Manifest source could not be compiled.",
  "manifest-resource-conflict": "Manifest sources produce conflicting resource identities.",
  "config-access-failed": "Configuration file could not be accessed.",
  "config-invalid": "Configuration is invalid.",
  "config-field-unknown":
    "Configuration contains an unknown field. Check the field name for typos or remove it.",
  "config-not-found": "Required configuration file was not found.",
  "config-parse-failed": "Configuration file could not be parsed.",
  "config-read-failed": "Configuration file could not be read safely.",
  "file-safe-read-unsupported": "This platform cannot safely open compilation inputs.",
  "file-not-regular": "Compilation input must be a regular file.",
  "file-outside-compilation-root": "Compilation input resolves outside the source root.",
  "frontmatter-invalid": "Document frontmatter is invalid.",
  "document-encoding-invalid": "Document is not valid UTF-8 text.",
  "guide-name-invalid":
    "Guide filenames must use lowercase letters, digits and single hyphens before .md or .mdx, such as getting-started.md, and the collection ID plus a hyphen and the filename stem must fit in 63 characters.",
  "guide-duplicate":
    "More than one Guide file produces the same Guide identity. Rename one file or, with sourceVersion 1, give it a distinct frontmatter id.",
  "reference-list-invalid": "Document resource references are invalid.",
  "reference-targets-invalid": "Resource reference target catalogue is invalid.",
  "wiki-page-not-found": "A configured Wiki page file was not found.",
  "wiki-page-ambiguous":
    "A Wiki source path matches more than one Markdown file. Keep exactly one source file.",
  "course-page-not-found": "A configured Course page file was not found.",
  "course-page-ambiguous":
    "A Course source path matches more than one Markdown file. Keep exactly one source file.",
  "author-not-found": "An author must reference a Person in the declared project.",
} as const;

export type PublicCompileErrorId = keyof typeof PUBLIC_COMPILE_ERROR_MESSAGES;

export function publicCompileErrorMessage(id: unknown): string | undefined {
  return typeof id === "string" && Object.hasOwn(PUBLIC_COMPILE_ERROR_MESSAGES, id)
    ? PUBLIC_COMPILE_ERROR_MESSAGES[id as PublicCompileErrorId]
    : undefined;
}

export interface PublicCompileErrorOptions extends ErrorOptions {
  /** Offending configuration or frontmatter field, such as `navigation[2].title`. */
  field?: string;
  /** Another safe relative location involved in the failure, such as a conflicting file. */
  relatedLocation?: string;
}

/**
 * Public compiler failure with fixed wording, stable ID, and optional safe relative location.
 * `field` and `relatedLocation` are sanitized like `location`; a `cause` stays a
 * non-enumerable debugging aid and is never part of the public wording.
 */
export class PublicCompileError extends Error {
  public readonly id: PublicCompileErrorId;
  public readonly location?: string;
  // Declared only, so absent details are not own properties.
  declare public readonly field?: string;
  declare public readonly relatedLocation?: string;

  constructor(id: PublicCompileErrorId, location?: string, options?: PublicCompileErrorOptions) {
    super(
      publicCompileErrorMessage(id) ?? "Compilation failed.",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "PublicCompileError";
    this.id = id;
    const safeLocation = sanitizeCompileLocation(location);
    if (safeLocation !== undefined) this.location = safeLocation;
    const safeField = sanitizeCompileField(options?.field);
    if (safeField !== undefined) this.field = safeField;
    const safeRelated = sanitizeCompileLocation(options?.relatedLocation);
    if (safeRelated !== undefined) this.relatedLocation = safeRelated;
  }
}

/**
 * Build a public error from a schema validation failure, keeping only the issue's
 * structural field path. Issue messages and input values stay private. An unknown
 * configuration key takes precedence because a misspelled key often also causes a
 * missing-field issue.
 */
export function publicSchemaError(
  id: "config-invalid" | "frontmatter-invalid",
  location: string | undefined,
  error: unknown,
): PublicCompileError {
  const issues = schemaIssues(error);
  const unknown = issues.find(
    (issue) => issue.code === "unrecognized_keys" && Array.isArray(issue.keys) && issue.keys.length,
  );
  const issue = unknown ?? issues[0];
  const path =
    issue === undefined ? undefined : [...issue.path, ...(unknown ? [unknown.keys![0]] : [])];
  return new PublicCompileError(
    unknown !== undefined && id === "config-invalid" ? "config-field-unknown" : id,
    location,
    { field: path === undefined ? undefined : formatFieldPath(path) },
  );
}

interface SchemaIssue {
  code?: unknown;
  path: readonly unknown[];
  keys?: readonly unknown[];
}

function schemaIssues(error: unknown): SchemaIssue[] {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is SchemaIssue =>
      issue !== null && typeof issue === "object" && Array.isArray((issue as SchemaIssue).path),
  );
}

function formatFieldPath(path: readonly unknown[]): string | undefined {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0)
      formatted += `[${segment}]`;
    else if (typeof segment === "string") formatted += formatted ? `.${segment}` : segment;
    else return undefined;
  }
  return formatted || undefined;
}

const FIELD_SEGMENT = String.raw`[A-Za-z_][A-Za-z0-9_-]{0,63}`;
const FIELD_PATTERN = new RegExp(
  String.raw`^(?:${FIELD_SEGMENT}|\[\d{1,6}\])(?:\.${FIELD_SEGMENT}|\[\d{1,6}\])*$`,
  "u",
);

function sanitizeCompileField(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= 256 && FIELD_PATTERN.test(value)
    ? value
    : undefined;
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
