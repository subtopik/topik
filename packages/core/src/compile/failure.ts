import { AssetCompilationError } from "./assets";
import {
  PublicCompileError,
  type PublicCompileErrorId,
  type PublicCompileErrorReason,
} from "./public-errors";
import { CompileError } from "./shared";

/**
 * Who has to act on a compilation failure:
 *
 * - `configuration`: the project manifest or a source configuration is missing or invalid.
 * - `content`: a document the project reads is missing, misnamed or invalid.
 * - `asset`: a local image or download a document references was refused.
 * - `environment`: the files may be fine, but this platform, Git installation or a file that
 *   changed during the read prevented a safe read. Retrying elsewhere or later can succeed.
 * - `tool`: the compiler or its caller failed; the author cannot fix it by editing the project.
 * - `unknown`: not an error the compiler raises.
 */
export type CompileFailureKind =
  | "configuration"
  | "content"
  | "asset"
  | "environment"
  | "tool"
  | "unknown";

export interface CompileFailureClassification {
  kind: CompileFailureKind;
  /** Stable ID of a `PublicCompileError`. */
  id?: PublicCompileErrorId;
  /** Known cause of a refused file read, such as `git-lfs-pointer`. */
  reason?: PublicCompileErrorReason;
  /** Safe project-relative location of a `PublicCompileError`, when it has one. */
  location?: string;
}

/** Every public error ID has a kind; a new ID does not type-check until it is added here. */
const KIND_BY_ID: Record<PublicCompileErrorId, CompileFailureKind> = {
  "manifest-required": "configuration",
  "manifest-invalid": "configuration",
  // Wraps an error the compiler did not expect from a source.
  "manifest-source-failed": "tool",
  "manifest-resource-conflict": "configuration",
  "config-access-failed": "configuration",
  "config-invalid": "configuration",
  "config-field-unknown": "configuration",
  "config-not-found": "configuration",
  "config-parse-failed": "configuration",
  "config-read-failed": "configuration",
  "file-safe-read-unsupported": "environment",
  "file-not-regular": "content",
  "file-outside-compilation-root": "content",
  "frontmatter-invalid": "content",
  "document-encoding-invalid": "content",
  "guide-name-invalid": "content",
  "guide-duplicate": "content",
  "reference-list-invalid": "content",
  // The catalogue of reference targets is supplied by the calling program, not the author.
  "reference-targets-invalid": "tool",
  "wiki-page-not-found": "content",
  "wiki-page-ambiguous": "content",
  "course-page-not-found": "content",
  "course-page-ambiguous": "content",
  // Sources written for an earlier release; the fix is a source migration.
  "course-order-removed": "configuration",
  "author-not-found": "content",
};

/** Whether a read-failure reason describes the machine or the moment, not the author's file. */
const ENVIRONMENT_REASON: Record<PublicCompileErrorReason, boolean> = {
  "symbolic-link": false,
  "hard-linked": false,
  executable: false,
  "special-file": false,
  "too-large": false,
  "git-lfs-pointer": false,
  "git-filtered": false,
  "git-submodule": false,
  "git-evidence-unavailable": true,
  "git-repository-untrusted": true,
  "platform-unsupported": true,
  "changed-during-read": true,
};

/**
 * Classify anything a compile function threw, so a caller can tell an author's content, an
 * author's media, the project configuration, the environment and a tool fault apart without
 * knowing the error classes. Never throws; an unrelated value is `unknown`.
 */
export function classifyCompileFailure(error: unknown): CompileFailureClassification {
  if (error instanceof PublicCompileError) {
    const environment = error.reason !== undefined && ENVIRONMENT_REASON[error.reason];
    return {
      kind: environment ? "environment" : KIND_BY_ID[error.id],
      id: error.id,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      ...(error.location === undefined ? {} : { location: error.location }),
    };
  }
  if (error instanceof CompileError) return { kind: "content" };
  if (error instanceof AssetCompilationError) {
    const environment = error.reason !== undefined && ENVIRONMENT_REASON[error.reason];
    return {
      kind: environment ? "environment" : "asset",
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    };
  }
  return { kind: "unknown" };
}
