import { resolve } from "node:path";
import { boolean, command, positional, string } from "@drizzle-team/brocli";
import { sanitizeTopikContentDiagnostic, type TopikContentDiagnostic } from "@topik/content";
import {
  isErrorDiagnostic,
  lint as lintContent,
  PublicCompileError,
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

/** Build the `--json` report from the same sanitized fields the text output prints. */
export function lintJsonReport(diagnostics: readonly TopikContentDiagnostic[]): LintJsonReport {
  return {
    diagnostics: diagnostics.map((diagnostic) => {
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
    errors: diagnostics.filter(isErrorDiagnostic).length,
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
    const { diagnostics } = await lintContent({
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
      const report = lintJsonReport(diagnostics);
      console.log(JSON.stringify(report));
      if (report.errors > 0) throw new PublicCliError("lint-failed");
      return;
    }
    printDiagnostics(diagnostics);

    const errors = diagnostics.filter(isErrorDiagnostic);
    if (errors.length > 0) {
      console.error(`${errors.length} lint error(s)`);
      throw new PublicCliError("lint-failed");
    }

    const warnings = diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
    console.log(`Lint passed${warnings > 0 ? ` with ${warnings} warning(s)` : ""}`);
  },
});
