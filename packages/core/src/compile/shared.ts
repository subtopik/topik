import {
  analyzeTopikContent,
  sanitizeTopikContentDiagnostic,
  type TopikContentDiagnostic,
  type TopikHeading,
} from "@topik/content";
import type { FileSafety } from "../assets/files";
import type { TopikAssetSemanticRecordV1, TopikMaterializationRecordV1 } from "../assets/identity";
import type { AssetPayload, CompiledResource } from "./assets";
import type { Person } from "@topik/schema/person/v1";
import type { SourceResource } from "../resource";
import { validateResources } from "../validate";
import { PublicCompileError } from "./public-errors";
import { parseSafeConfigurationYaml } from "./config";
import { markdownFrontmatter } from "./frontmatter";

export interface CompileResult {
  /** Present for manifest compilation, in declaration order. */
  provenance?: import("./manifest").ManifestSourceProvenance[];
  diagnostics: TopikContentDiagnostic[];
  resources: CompiledResource[];
  payloads: AssetPayload[];
  /**
   * Source file of each generated local Asset: Asset name to project-relative path. See
   * `AssetCompilationResult.assetSourcePaths`. Never written to compile output.
   */
  assetSourcePaths: Readonly<Record<string, string>>;
  semantic: TopikAssetSemanticRecordV1;
  materialization: TopikMaterializationRecordV1;
  /** Portable document references and their compilation-time validation state. */
  references: import("./links").CompiledResourceReference[];
}

export type LinkValidationPolicy = "error" | "warning" | "off";

/** How a standalone compiler reads files; the same options as `compile`. */
export interface CompileReadOptions {
  /**
   * How configuration and asset files are read where descriptor-anchored traversal is
   * unavailable (every platform except Linux). Defaults to `DEFAULT_FILE_SAFETY`.
   */
  fileSafety?: FileSafety;
  /** Absolute path of the Git executable used inside a Git checkout; see `CompileOptions`. */
  gitExecutable?: string;
}

export interface CompileValidationOptions {
  /** How unresolved document targets and invalid destination fragments are handled. */
  links?: LinkValidationPolicy;
}

export class CompileError extends Error {
  public readonly diagnostics: TopikContentDiagnostic[];

  constructor(diagnostics: TopikContentDiagnostic[]) {
    const sanitized = diagnostics.map(sanitizeTopikContentDiagnostic);
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

/**
 * Shift content diagnostic lines, which count from the start of the body, so they count from the
 * start of the file. `offset` is the number of lines before the body, such as frontmatter.
 */
export function withFileLines<T extends { lines: readonly number[] }>(
  diagnostics: readonly T[],
  offset: number | undefined,
): T[] {
  if (!offset) return [...diagnostics];
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    lines: diagnostic.lines.map((line) => line + offset),
  }));
}

export function parseMarkdownFrontmatter(
  raw: string,
  filePath: string,
): {
  frontmatter: Record<string, unknown>;
  content: string;
  /** Lines before the body, so a body line plus this is the line in the file. */
  bodyLineOffset: number;
} {
  const match = markdownFrontmatter(raw);
  if (!match) {
    return { frontmatter: {}, content: raw.replace(/^\uFEFF/u, ""), bodyLineOffset: 0 };
  }
  const bodyLineOffset = raw.slice(0, match.bodyStart).match(/\r\n|\r|\n/g)?.length ?? 0;

  try {
    // The YAML parser does not end lines at a lone CR; the content parser does.
    const frontmatter = parseSafeConfigurationYaml(match.frontmatter.replace(/\r\n?/gu, "\n"));
    if (frontmatter == null) {
      return { frontmatter: {}, content: match.content, bodyLineOffset };
    }
    if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
      throw new Error("Frontmatter must parse to an object");
    }
    if (
      "title" in frontmatter &&
      frontmatter.title != null &&
      typeof frontmatter.title !== "string"
    ) {
      throw new PublicCompileError("frontmatter-invalid", filePath, { field: "title" });
    }
    return {
      frontmatter: frontmatter as Record<string, unknown>,
      content: match.content,
      bodyLineOffset,
    };
  } catch (error) {
    // YAML parser messages can quote authored text, so only the structural field survives.
    if (error instanceof PublicCompileError) throw error;
    throw new PublicCompileError("frontmatter-invalid", filePath);
  }
}

export function extractMarkdownTitle(
  content: string,
  fallback: string,
  headings: readonly TopikHeading[] = analyzeTopikContent(content).headings,
): string {
  const heading = headings.find((entry) => entry.level === 1 && entry.title.length > 0);
  if (heading) {
    return heading.title;
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
      const file = sanitized.file ?? "content";
      const location = sanitized.lines.length > 0 ? `:${sanitized.lines.join(",")}` : "";
      return `${file}${location} ${sanitized.level} ${sanitized.id}: ${sanitized.message}`;
    })
    .join("\n");
}

/** Every Guide, Course and Course page author must name one of the compiled Persons. */
export function validateAuthors(
  resources: readonly SourceResource[],
  paths: Readonly<Record<string, string>>,
): void {
  const persons = new Set(
    resources.filter((resource) => resource.type === "Person").map((resource) => resource.name),
  );
  for (const resource of resources)
    if (
      (resource.type === "Guide" || resource.type === "Course" || resource.type === "CoursePage") &&
      resource.spec.authors?.some((author) => !persons.has(author))
    )
      throw new PublicCompileError("author-not-found", paths[`${resource.type}/${resource.name}`]);
}

/** The Persons a standalone compile is given in place of a project manifest's. */
export function standalonePersons(persons: readonly Person[] = []): Person[] {
  if (
    persons.some((person) => person?.type !== "Person") ||
    new Set(persons.map((person) => person.name)).size !== persons.length ||
    !validateResources(persons).valid
  )
    throw new TypeError("Expected unique, valid Person resources");
  return structuredClone([...persons]);
}
