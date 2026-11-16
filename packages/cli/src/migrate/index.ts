import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, positional } from "@drizzle-team/brocli";
import { TOPIK_MANIFEST_FILENAME } from "@topik/core";
import { AGENT_INSTRUCTIONS_FILENAME, writeAgentInstructions } from "../agents";
import { PublicCliError } from "../errors";

const OUTCOME_MESSAGES = {
  created: `Created ${AGENT_INSTRUCTIONS_FILENAME}`,
  updated: `Updated the Topik section of ${AGENT_INSTRUCTIONS_FILENAME}`,
  unchanged: `${AGENT_INSTRUCTIONS_FILENAME} is up to date`,
  kept: `Kept ${AGENT_INSTRUCTIONS_FILENAME} as it is: it has no single section between the Topik markers, or it is not a regular file`,
} as const;

/**
 * Bring the files `topik init` writes for tools up to date with this CLI. Today that is the
 * Topik section of `AGENTS.md`. Project sources are never changed.
 */
export async function migrateProject(dir: string): Promise<keyof typeof OUTCOME_MESSAGES> {
  const manifest = await stat(join(dir, TOPIK_MANIFEST_FILENAME)).catch(() => undefined);
  if (manifest?.isFile() !== true) throw new PublicCliError("migrate-project-missing");
  try {
    return await writeAgentInstructions(dir);
  } catch (error) {
    throw new PublicCliError("migrate-write-failed", { cause: error });
  }
}

export const migrate = command({
  name: "migrate",
  desc: `Update ${AGENT_INSTRUCTIONS_FILENAME} in a Topik project to this CLI version`,
  options: {
    dir: positional("dir").desc("Project directory containing .topik.yaml").default("."),
  },
  handler: async (options) => {
    console.log(OUTCOME_MESSAGES[await migrateProject(resolve(options.dir))]);
  },
});
