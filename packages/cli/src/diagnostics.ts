import type { TopikContentDiagnostic } from "@topik/content-schema";

export function formatDiagnostic(diagnostic: TopikContentDiagnostic): string {
  const file = diagnostic.file ?? "content";
  const lines = diagnostic.lines.length > 0 ? `:${diagnostic.lines.join(",")}` : "";
  return `${file}${lines} ${diagnostic.level} ${diagnostic.id}: ${diagnostic.message}`;
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
