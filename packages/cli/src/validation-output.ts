import { sanitizeTopikDiagnosticFile } from "@topik/content";
import type { ValidationError } from "@topik/core";
import { formatPublicCliError, PublicCliError } from "./errors";

/** A validation error, optionally located in the resource file it was read from. */
export interface LocatedValidationError extends ValidationError {
  file?: string;
}

const SAFE_LABEL_PART = /^[A-Za-z0-9._-]{1,128}$/u;
const SAFE_POINTER_SEGMENT = /^[A-Za-z0-9._~-]{0,128}$/u;
const SAFE_MESSAGE = /^[\x20-\x7e]{1,300}$/u;
const MAX_POINTER_SEGMENTS = 32;

/**
 * Render validation errors for terminal output. Every field can carry input
 * bytes (resource names, object keys, apiVersion values, file names), so each is
 * reduced to a safe label before it is printed.
 */
export function formatValidationFailure(
  errors: readonly LocatedValidationError[],
  resourceCount: number,
  context: string,
): string {
  const lines = errors.map((error) => {
    const file = error.file === undefined ? "" : `${safeFileLabel(error.file)}: `;
    return `${file}${safeResourceLabel(error.resource)}: ${safePointer(error.path)} ${safeMessage(error)}`;
  });
  lines.push("");
  lines.push(`${errors.length} validation error(s) in ${resourceCount} resources while ${context}`);
  return lines.join("\n");
}

/** Render a resource file that could not be read or parsed, with its safe label. */
export function formatUnreadableResourceFile(file: string, error: unknown): string {
  return `${safeFileLabel(file)}: ${formatPublicCliError(error)}`;
}

/** The check that produced a `topik validate --json` diagnostic. */
export type ValidationCheck = "read" | "schema" | "graph" | "content";

/** One `topik validate --json` diagnostic. Every field is always present. */
export interface ValidationDiagnosticJson {
  check: ValidationCheck;
  /** Stable diagnostic identifier, or `null` when there is none. */
  id: string | null;
  /** Target-relative resource file, or `null` when no file applies. */
  file: string | null;
  /** Resource `type/name`, or `null` for a file that could not be read. */
  resource: string | null;
  /** JSON pointer into the resource, or `null` for a file that could not be read. */
  pointer: string | null;
  message: string;
}

/** The `topik validate --json` document, version 1. */
export interface ValidationReportJson {
  version: 1;
  valid: boolean;
  /** Number of resources that were loaded and validated. */
  resources: number;
  /** Checks that ran, always starting with `schema`. */
  checks: ValidationCheck[];
  diagnostics: ValidationDiagnosticJson[];
}

/** A validation error as a JSON diagnostic, reduced to the same safe labels as terminal output. */
export function toValidationDiagnosticJson(
  error: LocatedValidationError,
  check: Exclude<ValidationCheck, "read">,
): ValidationDiagnosticJson {
  return {
    check,
    id: error.id ?? null,
    file: error.file === undefined ? null : safeFileLabel(error.file),
    resource: safeResourceLabel(error.resource),
    pointer: safePointer(error.path),
    message: safeMessage(error),
  };
}

/** A file or target that could not be read or parsed as a JSON diagnostic. */
export function toReadDiagnosticJson(
  file: string | undefined,
  error: unknown,
): ValidationDiagnosticJson {
  return {
    check: "read",
    id: error instanceof PublicCliError ? error.id : null,
    file: file === undefined ? null : safeFileLabel(file),
    resource: null,
    pointer: null,
    message: formatPublicCliError(error),
  };
}

function safeFileLabel(file: string): string {
  const label = sanitizeTopikDiagnosticFile(file);
  return label === undefined || (label === "content" && file !== "content")
    ? "resource file"
    : label;
}

function safeResourceLabel(label: string): string {
  const separator = label.indexOf("/");
  const type = separator === -1 ? label : label.slice(0, separator);
  const name = separator === -1 ? "" : label.slice(separator + 1);
  const safe = (part: string) => (SAFE_LABEL_PART.test(part) ? part : "unknown");
  return `${safe(type)}/${safe(name)}`;
}

/** Keep the longest prefix of the JSON pointer made of plain segments. */
function safePointer(pointer: string): string {
  if (!pointer.startsWith("/")) return "/";
  const segments: string[] = [];
  for (const segment of pointer.slice(1).split("/")) {
    if (segments.length >= MAX_POINTER_SEGMENTS || !SAFE_POINTER_SEGMENT.test(segment)) break;
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function safeMessage(error: ValidationError): string {
  // These messages interpolate the input's own type or apiVersion values.
  if (error.id === "resource-unsupported-version") return "Unsupported resource apiVersion";
  if (error.id === "resource-unsupported-type") return "Unsupported resource type";
  return SAFE_MESSAGE.test(error.message) ? error.message : "is invalid";
}
