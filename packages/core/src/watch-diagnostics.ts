import {
  sanitizeTopikContentDiagnostic,
  sanitizeTopikDiagnosticFile,
  type TopikContentDiagnostic,
} from "@topik/content";
import { AssetCompilationError } from "./compile/assets";
import {
  PublicCompileError,
  publicCompileErrorMessage,
  publicCompileReasonMessage,
} from "./compile/public-errors";
import { CompileError } from "./compile/shared";
import {
  PREVIEW_DIAGNOSTIC_LIMIT,
  type PreviewDiagnostic,
  type PreviewDiagnosticLocation,
} from "./preview";

/** Root-relative source path of each resource, from the last successful generation. */
export type ResourcesByPath = ReadonlyMap<string, { type: string; name: string }>;

export interface PreviewDiagnostics {
  diagnostics: PreviewDiagnostic[];
  omittedDiagnostics?: number;
}

const ASSET_DIAGNOSTIC_ID = /^[A-Z0-9_]{1,64}$/u;

function positive(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function located(
  path: string | undefined,
  resources: ResourcesByPath,
  line?: number,
  column?: number,
): Pick<PreviewDiagnostic, "location" | "resource"> {
  if (path === undefined) return {};
  const location: PreviewDiagnosticLocation = { path };
  const safeLine = positive(line);
  if (safeLine !== undefined) {
    location.line = safeLine;
    const safeColumn = positive(column);
    if (safeColumn !== undefined) location.column = safeColumn;
  }
  const resource = resources.get(path);
  return { location, ...(resource ? { resource: { ...resource } } : {}) };
}

/** Errors and warnings of a content compilation; informational levels stay in the terminal. */
function fromContent(
  diagnostic: TopikContentDiagnostic,
  resources: ResourcesByPath,
): PreviewDiagnostic | undefined {
  const safe = sanitizeTopikContentDiagnostic(diagnostic);
  const severity =
    safe.level === "error" || safe.level === "critical"
      ? "error"
      : safe.level === "warning"
        ? "warning"
        : undefined;
  if (severity === undefined) return undefined;
  return {
    id: safe.id,
    message: safe.message,
    severity,
    ...located(safe.file, resources, safe.lines[0], safe.column),
  };
}

function fromError(error: unknown, resources: ResourcesByPath): PreviewDiagnostic[] {
  if (error instanceof CompileError)
    return error.diagnostics.flatMap((diagnostic) => fromContent(diagnostic, resources) ?? []);
  if (error instanceof PublicCompileError)
    return [
      {
        id: error.id,
        message:
          publicCompileErrorMessage(error.id, error.reason) ??
          "Compilation failed. Check the source and try again.",
        severity: "error",
        ...located(error.location, resources),
      },
    ];
  if (error instanceof AssetCompilationError) {
    // Asset wording is not a stable surface and may describe the file; publish fixed text.
    const reason = publicCompileReasonMessage(error.reason);
    const message =
      reason === undefined
        ? "An image or download could not be compiled."
        : `An image or download could not be read. ${reason}`;
    const diagnostics = error.diagnostics.map((diagnostic) => {
      const path =
        typeof diagnostic.location?.path === "string"
          ? sanitizeTopikDiagnosticFile(diagnostic.location.path)
          : undefined;
      return {
        id: ASSET_DIAGNOSTIC_ID.test(diagnostic.id) ? diagnostic.id : "asset-compilation-failed",
        message,
        severity: "error" as const,
        ...located(path, resources),
      };
    });
    if (diagnostics.length > 0) return diagnostics;
    return [{ id: "asset-compilation-failed", message, severity: "error" }];
  }
  return [
    {
      id: "compilation-failed",
      message: "Compilation failed. Check the source and try again.",
      severity: "error",
    },
  ];
}

function limited(diagnostics: PreviewDiagnostic[]): PreviewDiagnostics {
  // Errors first, each group in compiler order.
  const ordered = [
    ...diagnostics.filter((diagnostic) => diagnostic.severity !== "warning"),
    ...diagnostics.filter((diagnostic) => diagnostic.severity === "warning"),
  ];
  const omitted = ordered.length - PREVIEW_DIAGNOSTIC_LIMIT;
  return {
    diagnostics: ordered.slice(0, PREVIEW_DIAGNOSTIC_LIMIT),
    ...(omitted > 0 ? { omittedDiagnostics: omitted } : {}),
  };
}

/** @internal Diagnostics of a failed compilation, as published in an `error` state. */
export function previewErrorDiagnostics(
  error: unknown,
  resources: ResourcesByPath,
): PreviewDiagnostics {
  return limited(fromError(error, resources));
}

/** @internal Warnings of a successful compilation, as published in a `ready` state. */
export function previewResultDiagnostics(
  diagnostics: readonly TopikContentDiagnostic[],
  resources: ResourcesByPath,
): PreviewDiagnostics {
  return limited(diagnostics.flatMap((diagnostic) => fromContent(diagnostic, resources) ?? []));
}
