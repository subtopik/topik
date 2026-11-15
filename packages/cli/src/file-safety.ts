import { string } from "@drizzle-team/brocli";
import { DEFAULT_FILE_SAFETY, usesPortableFileReads, type FileSafety } from "@topik/core";

/**
 * `--file-safety` for project commands. Its default is core's `DEFAULT_FILE_SAFETY`, so making
 * portable reads opt-in only needs that constant (and the documentation) to change.
 */
export function fileSafetyOption() {
  return string("file-safety")
    .desc(
      "How project files are read where descriptor-anchored reads are unavailable (macOS, Windows): portable checks paths and file identity and needs a trusted workspace; anchored refuses to run. Linux always uses anchored reads",
    )
    .enum("portable", "anchored")
    .default(DEFAULT_FILE_SAFETY);
}

export const PORTABLE_READS_NOTICE =
  "Note: this platform cannot anchor file access to the project directory, so topik checks paths and file identity instead. Use it only on a workspace you trust; pass --file-safety anchored to refuse.";

/** Tell the author once per command run when the weaker portable mode is in use. */
export function notePortableReads(fileSafety: FileSafety): void {
  if (usesPortableFileReads(fileSafety)) console.error(PORTABLE_READS_NOTICE);
}
