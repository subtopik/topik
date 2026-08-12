import {
  sanitizeTopikContentDiagnostic,
  sanitizeTopikDiagnosticFile,
  type TopikContentDiagnostic,
} from "@topik/content-schema";

export function formatDiagnostic(diagnostic: TopikContentDiagnostic): string {
  const sanitized = sanitizeTopikContentDiagnostic(diagnostic);
  const file = sanitizeTopikDiagnosticFile(sanitized.file) ?? "content";
  const lines = sanitized.lines.length > 0 ? `:${sanitized.lines.join(",")}` : "";
  return `${file}${lines} ${sanitized.level} ${sanitized.id}: ${sanitized.message}`;
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
