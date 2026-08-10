import type { TopikContentDiagnostic } from "@topik/content-schema";
import { isAbsolute, win32 } from "node:path";

export function formatDiagnostic(diagnostic: TopikContentDiagnostic): string {
  const file = sanitizeDiagnosticFile(diagnostic.file);
  const lines = diagnostic.lines.length > 0 ? `:${diagnostic.lines.join(",")}` : "";
  return `${file}${lines} ${diagnostic.level} ${diagnostic.id}: ${diagnostic.message}`;
}

function sanitizeDiagnosticFile(file: string | undefined): string {
  if (file === undefined) return "content";
  if (!isAbsolute(file) && !win32.isAbsolute(file)) return file;
  return file.replaceAll("\\", "/").split("/").at(-1) || "content";
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
