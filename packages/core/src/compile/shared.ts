import type { TopikContentDiagnostic } from "@topik/content-schema";
import { parse as parseYaml } from "yaml";
import type { Resource } from "../resource";

export interface CompileResult {
  diagnostics: TopikContentDiagnostic[];
  resources: Resource[];
}

export type LinkValidationPolicy = "error" | "warning" | "off";

export interface CompileValidationOptions {
  /** How unresolved wiki page links and same-page guide fragments are handled. */
  links?: LinkValidationPolicy;
}

export class CompileError extends Error {
  constructor(public readonly diagnostics: TopikContentDiagnostic[]) {
    super(formatContentDiagnostics(diagnostics));
    this.name = "CompileError";
  }
}

export function linkValidationPolicy(options?: CompileValidationOptions): LinkValidationPolicy {
  return options?.links ?? "error";
}

export function isErrorDiagnostic(diagnostic: TopikContentDiagnostic): boolean {
  return diagnostic.level === "error" || diagnostic.level === "critical";
}

export function hasCompileErrors(diagnostics: TopikContentDiagnostic[]): boolean {
  return diagnostics.some(isErrorDiagnostic);
}

export function throwOnCompileErrors(diagnostics: TopikContentDiagnostic[]): void {
  const errors = diagnostics.filter(isErrorDiagnostic);
  if (errors.length > 0) throw new CompileError(errors);
}

const DNS_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseMarkdownFrontmatter(
  raw: string,
  filePath: string,
): { frontmatter: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, content: raw };
  }

  try {
    const frontmatter = parseYaml(match[1]);
    if (frontmatter == null) {
      return { frontmatter: {}, content: match[2] };
    }
    if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
      throw new Error("Frontmatter must parse to an object");
    }
    if (
      "title" in frontmatter &&
      frontmatter.title != null &&
      typeof frontmatter.title !== "string"
    ) {
      throw new Error("Frontmatter title must be a string");
    }
    return { frontmatter, content: match[2] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid frontmatter in ${filePath}: ${message}`, { cause: error });
  }
}

export function extractMarkdownTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  return fallback
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatContentDiagnostics(diagnostics: TopikContentDiagnostic[]): string {
  return diagnostics
    .filter(isErrorDiagnostic)
    .map((diagnostic) => {
      const file = diagnostic.file ?? "content";
      const location = diagnostic.lines.length > 0 ? `:${diagnostic.lines.join(",")}` : "";
      return `${file}${location} ${diagnostic.level} ${diagnostic.id}: ${diagnostic.message}`;
    })
    .join("\n");
}

export function parseReferenceList(
  value: unknown,
  fieldName: string,
  filePath: string,
): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} in ${filePath} must be an array of resource names`);
  }

  const references = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${fieldName}[${index}] in ${filePath} must be a string`);
    }
    if (entry.length > 63 || !DNS_LABEL_PATTERN.test(entry)) {
      throw new Error(`${fieldName}[${index}] in ${filePath} must be a DNS-1123 resource name`);
    }
    return entry;
  });

  return references.length > 0 ? references : undefined;
}
