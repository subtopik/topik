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
  /** Optional source file path provided to the Markdoc parser. */
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

/** Fixed public wording for link diagnostics; authored targets are never accepted as input. */
export function topikLinkDiagnosticMessage(id: string): string | undefined {
  return TOPIK_LINK_DIAGNOSTIC_MESSAGES[id];
}

/** Re-apply the fixed link-message boundary when diagnostics cross package layers. */
export function sanitizeTopikContentDiagnostic(
  diagnostic: TopikContentDiagnostic,
): TopikContentDiagnostic {
  const message = topikLinkDiagnosticMessage(diagnostic.id);
  const file = sanitizeTopikDiagnosticFile(diagnostic.file);
  return (message === undefined || message === diagnostic.message) && file === diagnostic.file
    ? diagnostic
    : {
        ...diagnostic,
        ...(message === undefined ? {} : { message }),
        ...(file === undefined ? {} : { file }),
      };
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

function sanitizeTopikDiagnosticFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  if (!file.startsWith("/") && !file.startsWith("\\\\") && !/^[a-z]:[\\/]/iu.test(file)) {
    return file;
  }
  return file.replaceAll("\\", "/").split("/").at(-1) || "content";
}
