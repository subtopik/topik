import { sanitizeTopikContentDiagnostic, type TopikContentDiagnostic } from "@topik/content";

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
  const lines = sanitized.lines.length > 0 ? `:${sanitized.lines.join(",")}` : "";
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
