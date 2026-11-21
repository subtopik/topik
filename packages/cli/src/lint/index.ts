import { posix, resolve } from "node:path";
import { boolean, command, positional, string } from "@drizzle-team/brocli";
import {
  sanitizeTopikContentDiagnostic,
  sanitizeTopikDiagnosticFile,
  type TopikContentDiagnostic,
} from "@topik/content";
import {
  AssetCompilationError,
  isErrorDiagnostic,
  lint as lintContent,
  PublicCompileError,
  type LintFailure,
  type LinkValidationPolicy,
} from "@topik/core";
import { printDiagnostics } from "../diagnostics";
import { formatPublicCliError, PublicCliError, withProjectPlatformRequirement } from "../errors";
import { fileSafetyOption, notePortableReads } from "../file-safety";

/** One diagnostic in `topik lint --json` output. Optional fields are omitted when unknown. */
export interface LintJsonDiagnostic {
  file?: string;
  /** First one-based source line. */
  line?: number;
  /** Every one-based source line the diagnostic covers. */
  lines: number[];
  column?: number;
  id: string;
  severity: TopikContentDiagnostic["level"];
  message: string;
  /** Component name the diagnostic is about. */
  tag?: string;
  /** Attribute name the diagnostic is about, never its value. */
  attribute?: string;
  /** Code presentation option the diagnostic is about. */
  option?: string;
  /** Variable path the diagnostic is about. */
  variable?: string;
  /** What the component schema accepts: enum values, a type, or attribute names. */
  expected?: string[];
}

/** The single JSON document `topik lint --json` prints on stdout. */
export interface LintJsonReport {
  diagnostics: LintJsonDiagnostic[];
  errors: number;
  warnings: number;
}

/** The stable ID of a failure that stopped part of lint, for its JSON diagnostic. */
function failureId(error: unknown): string {
  if (error instanceof PublicCliError || error instanceof PublicCompileError) return error.id;
  if (error instanceof AssetCompilationError) {
    const id = error.diagnostics[0]?.id;
    if (typeof id === "string" && /^[A-Z0-9_]{1,64}$/.test(id)) return id;
  }
  return "lint-failed";
}

/** A failure's text line, prefixed with the documents that reference a failed Asset. */
export function formatLintFailure(failure: LintFailure): string {
  const documents = (failure.documents ?? [])
    .map((document) => sanitizeTopikDiagnosticFile(document))
    .filter((document): document is string => document !== undefined);
  const message = formatPublicCliError(withProjectPlatformRequirement(failure.error));
  return documents.length > 0 ? `${documents.join(", ")}: ${message}` : message;
}

/** A failure as error diagnostics: one for each document it was found in, or one without a file. */
function failureDiagnostics(failure: LintFailure): LintJsonDiagnostic[] {
  const error = withProjectPlatformRequirement(failure.error);
  const entry = { lines: [], id: failureId(error), severity: "error" as const };
  const message = formatPublicCliError(error);
  const documents = (failure.documents ?? [])
    .map((document) => sanitizeTopikDiagnosticFile(document))
    .filter((document): document is string => document !== undefined);
  if (documents.length > 0) return documents.map((file) => ({ file, ...entry, message }));
  // Only a location that names a file: a missing page's navigation entry, such as `docs/intro`,
  // stays in the message.
  const location =
    error instanceof PublicCompileError ? sanitizeTopikDiagnosticFile(error.location) : undefined;
  const file = location !== undefined && posix.extname(location) !== "" ? location : undefined;
  return [{ ...(file === undefined ? {} : { file }), ...entry, message }];
}

/** Build the `--json` report from the same sanitized fields the text output prints. */
export function lintJsonReport(
  diagnostics: readonly TopikContentDiagnostic[],
  failures: readonly LintFailure[] = [],
): LintJsonReport {
  const failed = failures.flatMap(failureDiagnostics);
  return {
    diagnostics: [
      ...diagnostics.map((diagnostic) => {
        const safe = sanitizeTopikContentDiagnostic(diagnostic);
        return {
          ...(safe.file === undefined ? {} : { file: safe.file }),
          ...(safe.lines.length > 0 ? { line: safe.lines[0] } : {}),
          lines: [...safe.lines],
          ...(safe.column === undefined ? {} : { column: safe.column }),
          id: safe.id,
          severity: safe.level,
          message: safe.message,
          ...(safe.tag === undefined ? {} : { tag: safe.tag }),
          ...(safe.attribute === undefined ? {} : { attribute: safe.attribute }),
          ...(safe.option === undefined ? {} : { option: safe.option }),
          ...(safe.variable === undefined ? {} : { variable: safe.variable }),
          ...(safe.expected === undefined ? {} : { expected: [...safe.expected] }),
        };
      }),
      ...failed,
    ],
    errors: diagnostics.filter(isErrorDiagnostic).length + failed.length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.level === "warning").length,
  };
}

export const lint = command({
  name: "lint",
  desc: "Lint Topik source content without writing compiled resources",
  options: {
    dir: positional("dir").desc("Project directory containing .topik.yaml").default("."),
    links: string("links")
      .desc("How unresolved wiki links and local guide fragments are handled")
      .enum("error", "warning", "off")
      .default("error"),
    json: boolean("json")
      .desc("Print diagnostics as one JSON document on stdout instead of text")
      .default(false),
    fileSafety: fileSafetyOption(),
  },
  handler: async (options) => {
    const links = options.links as LinkValidationPolicy;
    notePortableReads(options.fileSafety);
    const { diagnostics, failures } = await lintContent({
      dir: resolve(options.dir),
      validation: { links },
      fileSafety: options.fileSafety,
    }).catch((cause: unknown) => {
      const error = withProjectPlatformRequirement(cause);
      // A project that cannot be loaded is still reported as the one JSON document on stdout.
      if (options.json)
        console.log(
          JSON.stringify({
            diagnostics: [
              {
                lines: [],
                id:
                  error instanceof PublicCliError || error instanceof PublicCompileError
                    ? error.id
                    : "lint-failed",
                severity: "error",
                message: formatPublicCliError(error),
              },
            ],
            errors: 1,
            warnings: 0,
          } satisfies LintJsonReport),
        );
      throw error;
    });
    if (options.json) {
      const report = lintJsonReport(diagnostics, failures);
      console.log(JSON.stringify(report));
      if (report.errors > 0) throw new PublicCliError("lint-failed");
      return;
    }
    printDiagnostics(diagnostics);
    for (const failure of failures) console.error(formatLintFailure(failure));

    // Counted as in --json: a failed Asset counts once for each document that references it.
    const { errors, warnings } = lintJsonReport(diagnostics, failures);
    if (errors > 0) {
      console.error(`${errors} lint error(s)`);
      throw new PublicCliError("lint-failed");
    }

    console.log(`Lint passed${warnings > 0 ? ` with ${warnings} warning(s)` : ""}`);
  },
});
