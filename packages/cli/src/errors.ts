import { publicCompileErrorMessage, PublicCompileError, ManifestSourceError } from "@topik/core";

export class CliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
  }
}

const PUBLIC_CLI_ERROR_MESSAGES = Object.freeze({
  "browser-origin-invalid": "Browser origin configuration is invalid",
  "compilation-failed": "Compilation found errors.",
  "compilation-output-ancestor-unsafe":
    "Compilation output path has an unsafe or unresolvable ancestor directory.",
  "compilation-output-collision":
    "Compilation output contains a link or non-directory collision. Choose a new or empty output directory.",
  "compilation-output-contains-source":
    "Compilation output cannot equal or contain the source directory. Choose a different output directory.",
  "compilation-output-not-owned":
    "Existing compilation output is populated but is not recognized as owned. Choose a new or empty output directory.",
  "compilation-output-empty": "Compilation output directory must not be empty.",
  "compilation-output-platform-unsupported": "Writing compilation output requires Linux.",
  "compilation-publication-failed":
    "Compilation output publication failed after moving the existing output aside. For manual recovery, first stop concurrent writers, then inspect .topik-compilation-prior-* directories beside the output path. Verify the backup contents and do not overwrite an existing output path.",
  "compilation-source-access-failed": "Compilation source directory could not be accessed.",
  "compilation-validation-failed": "Compiled resource validation failed.",
  "dev-port-in-use": "Dev server port is already in use. Choose a different port with --port.",
  "dev-port-invalid": "Dev server port must be an integer from 0 to 65535.",
  "dev-server-listen-failed": "Dev server could not listen on the requested port.",
  "dev-source-access-failed":
    "Dev server source directory does not exist or could not be accessed.",
  "lint-failed": "Lint found errors.",
  "project-platform-unsupported":
    "topik compile, lint and dev currently require Linux, because this platform cannot read project files safely. Run them on Linux, for example in WSL 2 or a Linux container; topik validate works on any platform.",
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

  constructor(id: PublicCliErrorId, options?: ErrorOptions) {
    super(publicCliErrorMessage(id) ?? "Topik command failed.", options);
    this.name = "PublicCliError";
    this.id = id;
  }
}

function publicCliErrorMessage(id: unknown): string | undefined {
  return typeof id === "string" && Object.hasOwn(PUBLIC_CLI_ERROR_MESSAGES, id)
    ? PUBLIC_CLI_ERROR_MESSAGES[id as PublicCliErrorId]
    : undefined;
}

/**
 * Replace core's sanitized `platform-unsupported` read failure with the command-level
 * platform requirement. Project commands read `.topik.yaml` through core's Linux-only
 * anchored reader first, so on other platforms this is their first and only failure.
 */
export function withProjectPlatformRequirement(error: unknown): unknown {
  return error instanceof PublicCompileError && error.reason === "platform-unsupported"
    ? new PublicCliError("project-platform-unsupported", { cause: error })
    : error;
}

export function formatPublicCliError(error: unknown): string {
  if (error instanceof PublicCliError) {
    return publicCliErrorMessage(error.id) ?? "Topik command failed.";
  }
  if (error instanceof ManifestSourceError) {
    const message = publicCompileErrorMessage(error.id, error.reason) ?? "Topik command failed.";
    // Re-sanitize mutable error properties at the presentation boundary.
    const safe = resanitize(error);
    const index =
      Number.isSafeInteger(error.sourceIndex) && error.sourceIndex >= 0
        ? `sources[${error.sourceIndex}]`
        : "source";
    const kind =
      error.kind === "wiki" || error.kind === "collection" || error.kind === "course"
        ? ` (${error.kind})`
        : "";
    return `.topik.yaml ${index}${kind}${safe.location ? ` ${safe.location}` : ""}${details(safe)}: ${message}`;
  }
  if (error instanceof PublicCompileError) {
    return publicCompileErrorMessage(error.id, error.reason) ?? "Topik command failed.";
  }
  return "Topik command failed.";
}

function resanitize(error: PublicCompileError): PublicCompileError {
  return new PublicCompileError(error.id, error.location, {
    field: error.field,
    relatedLocation: error.relatedLocation,
  });
}

function details(error: PublicCompileError): string {
  return `${error.field ? ` field ${error.field}` : ""}${
    error.relatedLocation ? ` (conflicts with ${error.relatedLocation})` : ""
  }`;
}
