export type TopikContentDiagnosticLevel = "debug" | "info" | "warning" | "error" | "critical";

export interface ContentValidationIssue {
  type: string;
  lines: number[];
  location?: { file?: string };
  error: { id: string; level: TopikContentDiagnosticLevel; message: string };
}

export interface TopikContentDiagnostic {
  /** Stable diagnostic identifier. */
  id: string;
  /** Content node type that produced the diagnostic. */
  type: string;
  /** Diagnostic severity. */
  level: TopikContentDiagnosticLevel;
  /** Human-readable diagnostic message. */
  message: string;
  /** One-based source lines associated with the diagnostic, when available. */
  lines: number[];
  /** Optional sanitized source label. Absolute directories and URL secrets are removed. */
  file?: string;
  /** Authored template text slot, when available. */
  attribute?: string;
  /** Bounded authored variable path; context values are never included. */
  variable?: string;
  /** Supported code presentation option, with no authored/resolved values. */
  option?: string;
  /** One-based source column when available. */
  column?: number;
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
  "node-undefined": "A node is not supported.",
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
  "topik-accordion-children": "An accordion may contain only block content.",
  "topik-badge-children": "A badge requires inline content.",
  "topik-callout-children": "A callout may contain only block content.",
  "topik-card-children": "A card may contain only block content.",
  "topik-choice-children": "A choice may contain only block content.",
  "topik-code-group-children": "A code group contains an unsupported child.",
  "topik-code-group-requires-code-tab": "A code group requires at least one code tab.",
  "topik-code-group-parent-required": "A code tab must be nested inside a code group.",
  "topik-tabs-parent-required": "A tab must be nested inside tabs.",
  "topik-steps-parent-required": "A step must be nested inside steps.",
  "topik-code-tab-parent-required": "A code tab must be nested inside a code group.",
  "topik-code-tab-children": "A code tab may contain only fenced code blocks.",
  "topik-code-tab-requires-fence": "A code tab requires a fenced code block.",
  "topik-columns-range": "Card grid columns must be an integer from 1 to 4.",
  "topik-config-invalid": "Content configuration is invalid.",
  "topik-content-limit": "Content exceeds the supported complexity limits.",
  "topik-node-invalid": "A Markdown node cannot be represented without changing its meaning.",
  "topik-reference-missing": "A reference has no definition in its conditional scope.",
  "topik-reference-label": "A reference identifier has no faithful Markdown label.",
  "topik-write-failed": "Content could not be written without changing its meaning.",
  "topik-extension-failed": "Content extension validation failed.",
  "topik-explanation-children": "An explanation may contain only block content.",
  "topik-figure-children": "A figure cannot contain children; use its alt and caption attributes.",
  "topik-math-children": "Block math cannot contain children; use its content attribute.",
  "topik-math-inline-children": "Inline math cannot contain children; use its content attribute.",
  "topik-mark-nesting":
    "Emphasis and strong marks allow at most two levels each; strikethrough cannot be nested.",
  "topik-question-choice-count": "A question requires at least two choices.",
  "topik-question-children": "A question contains an unsupported child.",
  "topik-question-correct-choice-required":
    "A multiple-choice question requires at least one correct choice.",
  "topik-question-parent-required": "Choices and explanations must be nested inside a question.",
  "topik-question-single-correct-choice":
    "A single-choice question requires exactly one correct choice.",
  "topik-partial-cycle": "Partial references must not be cyclic.",
  "topik-partial-invalid": "Partial content is invalid or unavailable.",
  "topik-quiz-children": "A quiz contains an unsupported child.",
  "topik-quiz-requires-question": "A quiz requires at least one question.",
  "topik-step-parent-required": "A step must be nested inside steps.",
  "topik-step-children": "A step may contain only block content.",
  "topik-steps-children": "Steps contain an unsupported child.",
  "topik-steps-requires-step": "Steps require at least one step.",
  "topik-tab-parent-required": "A tab must be nested inside tabs.",
  "topik-tab-children": "A tab may contain only block content.",
  "topik-tabs-children": "Tabs contain an unsupported child.",
  "topik-tabs-requires-tab": "Tabs require at least one tab.",
  "topik-transform-failed": "Content transformation failed.",
  "topik-empty-paragraph": "Empty paragraphs cannot be written as Markdown.",
  "topik-frontmatter-placement": "Frontmatter must be the first node in the document.",
  "topik-variable-path": "Variable paths must use supported property names.",
  "topik-variable-placement": "Variables must appear in inline content.",
  "topik-template-syntax": "Text templates require valid variable tokens or escaped openers.",
  "topik-template-location": "Text templates are not supported in this attribute.",
  "topik-code-template-structure":
    "A code template requires exactly one closed fenced code block in the same content scope.",
  "topik-code-template-language": "Code templates require a language that displays plain text.",
  "topik-code-presentation-scope":
    "A presentation requires one code or code-template child; remove nested or extra blocks.",
  "topik-code-presentation-metadata":
    'Use fence attributes such as filename="client.ts", lines and highlight="1,3-5"; quote values containing spaces.',
  "topik-code-presentation-option":
    "Use supported presentation options with valid labels, booleans and integer bounds.",
  "topik-code-presentation-lines":
    "Select physical rows using positive numbers or closed ranges, separated by commas without spaces.",
  "topik-code-presentation-line-bounds":
    "Keep line selections within the physical payload rows; startLine changes labels only.",
  "topik-code-presentation-diff-conflict": "Choose disjoint added and removed row selections.",
  "topik-code-presentation-language":
    "Use presentation attributes with text code languages rather than interpreted Mermaid diagrams.",
  "topik-template-variable-missing": "A template variable is not defined.",
  "topik-template-variable-type":
    "Template variables require strings, finite numbers, booleans, or null.",
  "topik-template-control": "Template text contains an unsupported control character.",
  "topik-expression-invalid": "The conditional expression is not supported.",
  "topik-conditional-placement": "Conditions must appear in ordinary block content.",
  "topik-conditional-branches": "A condition requires one branch and at most one alternative.",
  "topik-conditional-children": "Conditional branches must contain block content.",
  "topik-tag-children": "The component requires a different opening or closing form.",
  "topik-tag-placement": "The component cannot appear in this location.",
  "topik-card-grid-children": "A card grid may contain only cards.",
  "topik-quiz-parent-required": "A question must be nested inside a quiz.",
  "topik-underline-children": "Underline requires inline content.",
  "topik-u-children": "Underline requires inline content.",
  "variable-undefined": "A referenced variable is not defined.",
};

const DIAGNOSTIC_URL_BASE = new URL("https://topik.invalid/");
const EXPLICIT_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const WINDOWS_DRIVE_PREFIX = /^[a-z]:/iu;

/** Fixed public wording for link diagnostics; authored targets are never accepted as input. */
export function topikLinkDiagnosticMessage(id: string): string | undefined {
  return Object.hasOwn(TOPIK_LINK_DIAGNOSTIC_MESSAGES, id)
    ? TOPIK_LINK_DIAGNOSTIC_MESSAGES[id]
    : undefined;
}

/** Re-apply fixed public messages and safe file labels when diagnostics cross package layers. */
export function sanitizeTopikContentDiagnostic(
  diagnostic: TopikContentDiagnostic,
): TopikContentDiagnostic {
  const message = Object.hasOwn(TOPIK_CONTENT_DIAGNOSTIC_MESSAGES, diagnostic.id)
    ? TOPIK_CONTENT_DIAGNOSTIC_MESSAGES[diagnostic.id]
    : "Content validation failed.";
  const file = sanitizeTopikDiagnosticFile(diagnostic.file);
  const {
    file: _untrustedFile,
    message: _untrustedMessage,
    attribute,
    variable,
    option,
    column,
    ...safe
  } = diagnostic;
  const template =
    diagnostic.id.startsWith("topik-template-") || diagnostic.id === "topik-variable-path";
  return {
    ...safe,
    message,
    ...(diagnostic.id.startsWith("topik-code-presentation-") &&
    typeof option === "string" &&
    [
      "filename",
      "title",
      "lineNumbers",
      "startLine",
      "highlight",
      "focus",
      "collapse",
      "wrap",
      "added",
      "removed",
    ].includes(option)
      ? { option }
      : {}),
    ...(diagnostic.id.startsWith("topik-code-presentation-") &&
    typeof column === "number" &&
    Number.isSafeInteger(column) &&
    column > 0 &&
    column <= 1_000_000
      ? { column }
      : {}),
    ...(file === undefined ? {} : { file }),
    ...(template && attribute !== undefined && ["title", "alt", "caption"].includes(attribute)
      ? { attribute }
      : {}),
    ...(template &&
    typeof variable === "string" &&
    variable.length <= 256 &&
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(variable)
      ? { variable }
      : {}),
  };
}

export function toTopikContentDiagnostic(error: ContentValidationIssue): TopikContentDiagnostic {
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
  if (hasAmbiguousDiagnosticCharacter(file) || hasHtmlCharacterReference(file)) return "content";

  if (WINDOWS_DRIVE_PREFIX.test(file) || file.startsWith("\\")) {
    return safeDiagnosticBasename(file);
  }

  if (
    EXPLICIT_URL_SCHEME.test(file) ||
    file.startsWith("//") ||
    file.includes("?") ||
    file.includes("#")
  ) {
    try {
      const url = new URL(file, DIAGNOSTIC_URL_BASE);
      return url.pathname.startsWith("/") ? safeDiagnosticBasename(url.pathname) : "content";
    } catch {
      return "content";
    }
  }

  if (file.startsWith("/")) return safeDiagnosticBasename(file);
  return isSafeRelativeDiagnosticLabel(file) ? file : "content";
}

function hasAmbiguousDiagnosticCharacter(value: string): boolean {
  return /[%\p{Cc}\p{Cf}\p{Separator}\p{White_Space}]/u.test(value);
}

function hasHtmlCharacterReference(value: string): boolean {
  return /&(?:#(?:x[0-9a-f]*|[0-9]*)|[a-z][a-z0-9]*);?/iu.test(value);
}

function safeDiagnosticBasename(file: string): string {
  const basename = file.replaceAll("\\", "/").split("/").at(-1);
  const label = basename?.split(/[?#]/u, 1)[0];
  return label !== undefined && isSafeRelativeDiagnosticLabel(label) ? label : "content";
}

function isSafeRelativeDiagnosticLabel(value: string): boolean {
  return /^(?!\.\.?$)[a-z0-9._-]+(?:[\\/][a-z0-9._-]+)*$/iu.test(value);
}
