import { publicCompileErrorMessage, PublicCompileError } from "@topik/core";

export class CliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
  }
}

const PUBLIC_CLI_ERROR_MESSAGES = Object.freeze({
  "browser-origin-invalid": "Browser origin configuration is invalid",
  "resource-access-failed": "Resource input could not be accessed.",
  "resource-format-unsupported": "Resource input format is unsupported.",
  "resource-json-invalid": "JSON resource input could not be parsed.",
  "resource-jsonl-invalid": "JSONL resource input could not be parsed.",
  "resource-read-failed": "Resource input could not be read.",
  "resource-validation-failed": "Resource validation failed.",
  "resource-yaml-invalid": "YAML resource input could not be parsed.",
});

export type PublicCliErrorId = keyof typeof PUBLIC_CLI_ERROR_MESSAGES;

/** CLI failure admitted to presentation only through fixed catalog wording. */
export class PublicCliError extends CliError {
  public readonly id: PublicCliErrorId;

  constructor(id: PublicCliErrorId) {
    super(publicCliErrorMessage(id) ?? "Topik command failed.");
    this.name = "PublicCliError";
    this.id = id;
  }
}

function publicCliErrorMessage(id: unknown): string | undefined {
  return typeof id === "string" && Object.hasOwn(PUBLIC_CLI_ERROR_MESSAGES, id)
    ? PUBLIC_CLI_ERROR_MESSAGES[id as PublicCliErrorId]
    : undefined;
}

export function formatPublicCliError(error: unknown): string {
  if (error instanceof PublicCliError) {
    return publicCliErrorMessage(error.id) ?? "Topik command failed.";
  }
  if (error instanceof PublicCompileError) {
    return publicCompileErrorMessage(error.id) ?? "Topik command failed.";
  }
  return "Topik command failed.";
}
