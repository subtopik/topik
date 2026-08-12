import {
  sanitizeTopikContentDiagnostic,
  sanitizeTopikDiagnosticFile,
  type TopikContentDiagnostic,
} from "@topik/content-schema";
import { parse as parseYaml } from "yaml";
import type { Resource } from "../resource";
import type { TopikAssetSemanticRecordV1, TopikMaterializationRecordV1 } from "../assets/identity";
import type { AssetPayload } from "./assets";
import { PublicCompileError } from "./public-errors";

export interface CompileResult {
  diagnostics: TopikContentDiagnostic[];
  resources: Resource[];
  payloads: AssetPayload[];
  semantic: TopikAssetSemanticRecordV1;
  materialization: TopikMaterializationRecordV1;
}

export type LinkValidationPolicy = "error" | "warning" | "off";

export interface CompileValidationOptions {
  /** How unresolved wiki page links and same-page guide fragments are handled. */
  links?: LinkValidationPolicy;
}

export class CompileError extends Error {
  public readonly diagnostics: TopikContentDiagnostic[];

  constructor(diagnostics: TopikContentDiagnostic[]) {
    const sanitized = diagnostics.map(sanitizeContentDiagnostic);
    super(formatContentDiagnostics(sanitized));
    this.name = "CompileError";
    this.diagnostics = sanitized;
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
  } catch {
    throw new PublicCompileError("frontmatter-invalid", filePath);
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
      const sanitized = sanitizeTopikContentDiagnostic(diagnostic);
      const file = sanitizeTopikDiagnosticFile(sanitized.file) ?? "content";
      const location = sanitized.lines.length > 0 ? `:${sanitized.lines.join(",")}` : "";
      return `${file}${location} ${sanitized.level} ${sanitized.id}: ${sanitized.message}`;
    })
    .join("\n");
}

function sanitizeContentDiagnostic(diagnostic: TopikContentDiagnostic): TopikContentDiagnostic {
  return sanitizeTopikContentDiagnostic(diagnostic);
}

export function parseReferenceList(
  value: unknown,
  _fieldName: string,
  filePath: string,
): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new PublicCompileError("reference-list-invalid", filePath);
  }

  const references = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new PublicCompileError("reference-list-invalid", filePath);
    }
    if (entry.length > 63 || !DNS_LABEL_PATTERN.test(entry)) {
      throw new PublicCompileError("reference-list-invalid", filePath);
    }
    return entry;
  });

  return references.length > 0 ? references : undefined;
}
