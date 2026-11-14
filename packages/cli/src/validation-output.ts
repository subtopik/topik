import { sanitizeTopikDiagnosticFile } from "@topik/content";
import type { ValidationError } from "@topik/core";
import { formatPublicCliError } from "./errors";

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
