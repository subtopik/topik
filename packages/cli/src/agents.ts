import { lstat, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_INSTRUCTIONS_FILENAME, replaceFile } from "./format";

export { AGENT_INSTRUCTIONS_FILENAME };
export const AGENT_INSTRUCTIONS_START_MARKER = "<!--TOPIK START-->";
export const AGENT_INSTRUCTIONS_END_MARKER = "<!--TOPIK END-->";

/**
 * The section Topik owns in a project's `AGENTS.md`. The text is the same however the CLI was
 * started, so `topik migrate` changes a file only when a newer CLI ships a different section.
 */
export const AGENT_INSTRUCTIONS = `${AGENT_INSTRUCTIONS_START_MARKER}

# Writing Topik content

This project uses [Topik](https://github.com/subtopik/topik), a toolkit for educational content written in Topik Markdown. The \`topik\` command formats, lints, compiles and previews it. Run \`topik --help\` to list the commands and \`topik <command> --help\` for the options of one command.

The guides for the installed version are local at \`node_modules/@topik/cli/docs\` when \`@topik/cli\` is a dependency of this project. They are online at https://github.com/subtopik/topik/tree/main/docs. Start with \`content/content-design.md\` for the Markdown syntax and \`resources/index.md\` for the project layout.

## Checklist

- Run \`topik format <file>\` on the Markdown files you changed.
- Run \`topik lint\` to check content and links without writing output.
- Run \`topik compile --validate\` before publishing the compiled resources.
- Run \`topik migrate\` after upgrading \`@topik/cli\` to update this section.

${AGENT_INSTRUCTIONS_END_MARKER}
`;

/**
 * Replace the section between the markers in `existing` with the one in `incoming`. Returns
 * `undefined` unless `existing` holds exactly one start marker followed by exactly one end
 * marker, so text outside the section is never touched and a damaged section is left alone.
 */
export function replaceAgentInstructionsSection(
  existing: string,
  incoming: string = AGENT_INSTRUCTIONS,
): string | undefined {
  const target = markedRange(existing);
  const source = markedRange(incoming);
  if (target === undefined || source === undefined) return undefined;
  return (
    existing.slice(0, target.start) +
    incoming.slice(source.start, source.end) +
    existing.slice(target.end)
  );
}

function markedRange(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(AGENT_INSTRUCTIONS_START_MARKER);
  const end = text.indexOf(AGENT_INSTRUCTIONS_END_MARKER);
  if (start === -1 || end === -1 || end < start) return undefined;
  if (text.indexOf(AGENT_INSTRUCTIONS_START_MARKER, start + 1) !== -1) return undefined;
  if (text.indexOf(AGENT_INSTRUCTIONS_END_MARKER, end + 1) !== -1) return undefined;
  return { start, end: end + AGENT_INSTRUCTIONS_END_MARKER.length };
}

/**
 * - `created`: there was no file; it now holds the section.
 * - `updated`: the marked section was replaced.
 * - `unchanged`: the marked section is current.
 * - `kept`: the file has no single marked section, is not a regular file, or changed while it
 *   was being replaced. It is left as it is.
 */
export type AgentInstructionsOutcome = "created" | "updated" | "unchanged" | "kept";

/** What `topik init` and `topik migrate` print for each outcome. */
export const AGENT_INSTRUCTIONS_OUTCOME_MESSAGES: Record<AgentInstructionsOutcome, string> = {
  created: `Created ${AGENT_INSTRUCTIONS_FILENAME}`,
  updated: `Updated the Topik section of ${AGENT_INSTRUCTIONS_FILENAME}`,
  unchanged: `${AGENT_INSTRUCTIONS_FILENAME} is up to date`,
  kept: `Kept ${AGENT_INSTRUCTIONS_FILENAME} as it is: it has no single section between the Topik markers, or it is not a regular file`,
};

/**
 * Create `AGENTS.md` in `dir`, or update the section Topik owns in an existing one. An existing
 * file is never followed through a link and is replaced through a temporary file, as
 * `topik format` replaces files.
 */
export async function writeAgentInstructions(dir: string): Promise<AgentInstructionsOutcome> {
  const path = join(dir, AGENT_INSTRUCTIONS_FILENAME);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) {
    // Exclusive creation: a file or link that appears meanwhile is not followed or replaced.
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(AGENT_INSTRUCTIONS);
    } catch (error) {
      // Do not leave a partly written file behind; this call created it.
      await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
    return "created";
  }
  if (!info.isFile()) return "kept";

  const bytes = await readFile(path);
  const existing = bytes.toString("utf8");
  // Bytes that are not valid UTF-8 would not survive the round trip through a string.
  if (!Buffer.from(existing, "utf8").equals(bytes)) return "kept";
  const updated = replaceAgentInstructionsSection(existing);
  if (updated === undefined) return "kept";
  if (updated === existing) return "unchanged";
  const replaced = await replaceFile(
    { root: dir, path: AGENT_INSTRUCTIONS_FILENAME, label: AGENT_INSTRUCTIONS_FILENAME },
    bytes,
    Buffer.from(updated, "utf8"),
  );
  return replaced ? "updated" : "kept";
}
