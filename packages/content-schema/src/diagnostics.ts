import type { ValidateError, ValidationError } from "@markdoc/markdoc";

export type TopikContentDiagnosticLevel = ValidationError["level"];

export interface TopikContentDiagnostic {
  /** Stable diagnostic identifier. */
  id: string;
  /** Markdoc node type that produced the diagnostic. */
  type: string;
  /** Diagnostic severity. */
  level: TopikContentDiagnosticLevel;
  /** Human-readable diagnostic message. */
  message: string;
  /** One-based source lines associated with the diagnostic, when available. */
  lines: number[];
  /** Optional sanitized source label. Absolute directories and URL secrets are removed. */
  file?: string;
}

const TOPIK_LINK_DIAGNOSTIC_MESSAGES: Readonly<Record<string, string>> = {
  "link-asset-invalid": "Asset link target is not a canonical generated name.",
  "link-asset-navigation-unsupported": "Navigation targets cannot use generated Asset names.",
  "link-fragment-not-found": "Link target heading was not found.",
  "link-href-empty": "Link target is required.",
  "link-page-not-found": "Internal link target page was not found.",
  "link-scheme-unsafe": "Link scheme is unsafe.",
  "link-scheme-unsupported": "Link scheme is unsupported.",
  "link-url-credentials": "Link URL credentials are not supported.",
  "link-url-invalid": "Link target is not a valid URL reference.",
  "link-url-protocol-relative": "Protocol-relative link targets are not supported.",
};

const TOPIK_CONTENT_DIAGNOSTIC_MESSAGES: Readonly<Record<string, string>> = {
  ...TOPIK_LINK_DIAGNOSTIC_MESSAGES,
  TOPIK_ASSET_PATH_INVALID: "Local Asset reference is not canonical.",
  TOPIK_ASSET_REFERENCE_MALFORMED: "Asset reference has an invalid generated name.",
  TOPIK_EXTERNAL_REFERENCE_UNSAFE: "External Asset reference requires credential-free HTTPS.",
  "attribute-missing-required": "A required attribute is missing.",
  "attribute-type-invalid": "An attribute has an invalid type.",
  "attribute-undefined": "An attribute is not supported.",
  "attribute-value-invalid": "An attribute has an invalid value.",
  "child-invalid": "A child node is not supported in this location.",
  "duplicate-attribute": "An attribute is specified more than once.",
  "fence-tag-error": "A fenced tag is invalid.",
  "function-undefined": "A referenced function is not defined.",
  "heading-id-duplicate": "Explicit heading IDs must be unique within a document.",
  "missing-closing": "Content has a missing closing delimiter.",
  "missing-opening": "Content has a missing opening delimiter.",
  "no-inline-annotations": "Inline annotations are not supported in this location.",
  "parameter-missing-required": "A required function parameter is missing.",
  "parameter-type-invalid": "A function parameter has an invalid type.",
  "parameter-undefined": "A function parameter is not supported.",
  "parse-error": "Content could not be parsed.",
  "slot-missing-required": "A required slot is missing.",
  "slot-undefined": "A slot is not supported.",
  "table-syntax": "Table syntax is invalid.",
  "tag-placement-invalid": "A tag is not supported in this location.",
  "tag-selfclosing-has-children": "A self-closing tag cannot contain children.",
  "tag-undefined": "A tag is not supported.",
  "topik-code-group-children": "A code group contains an unsupported child.",
  "topik-code-group-requires-code-tab": "A code group requires at least one code tab.",
  "topik-code-tab-parent-required": "A code tab must be nested inside a code group.",
  "topik-code-tab-requires-fence": "A code tab requires a fenced code block.",
  "topik-columns-range": "Card grid columns must be an integer from 1 to 4.",
  "topik-question-choice-count": "A question requires at least two choices.",
  "topik-question-children": "A question contains an unsupported child.",
  "topik-question-correct-choice-required":
    "A multiple-choice question requires at least one correct choice.",
  "topik-question-parent-required": "A question must be nested inside a quiz.",
  "topik-question-single-correct-choice":
    "A single-choice question requires exactly one correct choice.",
  "topik-partial-cycle": "Partial references must not be cyclic.",
  "topik-partial-invalid": "Partial content is invalid or unavailable.",
  "topik-quiz-children": "A quiz contains an unsupported child.",
  "topik-quiz-requires-question": "A quiz requires at least one question.",
  "topik-step-parent-required": "A step must be nested inside steps.",
  "topik-steps-children": "Steps contain an unsupported child.",
  "topik-steps-requires-step": "Steps require at least one step.",
  "topik-tab-parent-required": "A tab must be nested inside tabs.",
  "topik-tabs-children": "Tabs contain an unsupported child.",
  "topik-tabs-requires-tab": "Tabs require at least one tab.",
  "variable-undefined": "A referenced variable is not defined.",
};

const DIAGNOSTIC_URL_BASE = new URL("https://topik.invalid/");
const EXPLICIT_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const WINDOWS_DRIVE_PREFIX = /^[a-z]:/iu;

/** Fixed public wording for link diagnostics; authored targets are never accepted as input. */
export function topikLinkDiagnosticMessage(id: string): string | undefined {
  return TOPIK_LINK_DIAGNOSTIC_MESSAGES[id];
}

/** Re-apply fixed public messages and safe file labels when diagnostics cross package layers. */
export function sanitizeTopikContentDiagnostic(
  diagnostic: TopikContentDiagnostic,
): TopikContentDiagnostic {
  const message = TOPIK_CONTENT_DIAGNOSTIC_MESSAGES[diagnostic.id] ?? "Content validation failed.";
  const file = sanitizeTopikDiagnosticFile(diagnostic.file);
  const { file: _untrustedFile, message: _untrustedMessage, ...safe } = diagnostic;
  return { ...safe, message, ...(file === undefined ? {} : { file }) };
}

export function toTopikContentDiagnostic(error: ValidateError): TopikContentDiagnostic {
  return sanitizeTopikContentDiagnostic({
    id: error.error.id,
    type: error.type,
    level: error.error.level,
    message: error.error.message,
    lines: error.lines,
    ...(error.location?.file ? { file: error.location.file } : {}),
  });
}

/** Convert an untrusted diagnostic location to a browser-compatible safe label. */
export function sanitizeTopikDiagnosticFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  if (file.trim() !== file || hasAsciiControl(file) || file.includes("%")) return "content";

  if (WINDOWS_DRIVE_PREFIX.test(file) || file.startsWith("\\")) {
    return diagnosticBasename(file);
  }

  if (
    EXPLICIT_URL_SCHEME.test(file) ||
    file.startsWith("//") ||
    file.includes("?") ||
    file.includes("#")
  ) {
    try {
      const url = new URL(file, DIAGNOSTIC_URL_BASE);
      return url.pathname.startsWith("/") ? diagnosticBasename(url.pathname) : "content";
    } catch {
      return "content";
    }
  }

  return file.startsWith("/") ? diagnosticBasename(file) : file;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function diagnosticBasename(file: string): string {
  const basename = file.replaceAll("\\", "/").split("/").at(-1);
  const label = basename?.split(/[?#]/u, 1)[0];
  return !label || label === "." || label === ".." ? "content" : label;
}
