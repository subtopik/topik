import { sanitizeTopikContentDiagnostic, type TopikContentDiagnostic } from "@topik/content";
import type { PreviewDiagnostic, PreviewState } from "@topik/core";

/** The structured context of a sanitized diagnostic, as ` (tag: …; attribute: …)` or nothing. */
function formatDetail(sanitized: TopikContentDiagnostic): string {
  const parts = [
    sanitized.tag === undefined ? undefined : `tag: ${sanitized.tag}`,
    sanitized.attribute === undefined ? undefined : `attribute: ${sanitized.attribute}`,
    sanitized.option === undefined ? undefined : `option: ${sanitized.option}`,
    sanitized.variable === undefined ? undefined : `variable: ${sanitized.variable}`,
    sanitized.expected === undefined ? undefined : `expected: ${sanitized.expected.join(", ")}`,
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

export function formatDiagnostic(diagnostic: TopikContentDiagnostic): string {
  const sanitized = sanitizeTopikContentDiagnostic(diagnostic);
  const file = sanitized.file ?? "content";
  // `path:line:column` when the column is known, the form editors and terminals link.
  const lines =
    sanitized.lines.length === 0
      ? ""
      : sanitized.column !== undefined && sanitized.lines.length === 1
        ? `:${sanitized.lines[0]}:${sanitized.column}`
        : `:${sanitized.lines.join(",")}`;
  return `${file}${lines} ${sanitized.level} ${sanitized.id}: ${sanitized.message}${formatDetail(sanitized)}`;
}

export function printDiagnostics(diagnostics: TopikContentDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const output = formatDiagnostic(diagnostic);
    if (diagnostic.level === "error" || diagnostic.level === "critical") {
      console.error(output);
    } else {
      console.warn(output);
    }
  }
}

/** A preview diagnostic as `path:line:column severity id: message`, like a compile diagnostic. */
export function formatPreviewDiagnostic(diagnostic: PreviewDiagnostic): string {
  const { location } = diagnostic;
  const position =
    location === undefined
      ? "content"
      : `${location.path}${location.line === undefined ? "" : `:${location.line}`}${
          location.line === undefined || location.column === undefined ? "" : `:${location.column}`
        }`;
  return `${position} ${diagnostic.severity ?? "error"} ${diagnostic.id}: ${diagnostic.message}`;
}

/** Prints the warnings a ready preview state carries; its errors are reported on failure. */
export function printPreviewWarnings(state: PreviewState): void {
  const warnings = state.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  for (const warning of warnings) console.warn(formatPreviewDiagnostic(warning));
  if (state.omittedDiagnostics !== undefined && state.omittedDiagnostics > 0)
    console.warn(`… and ${state.omittedDiagnostics} more warnings`);
}
