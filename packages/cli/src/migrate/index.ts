import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, positional } from "@drizzle-team/brocli";
import { TOPIK_MANIFEST_FILENAME } from "@topik/core";
import {
  AGENT_INSTRUCTIONS_FILENAME,
  AGENT_INSTRUCTIONS_OUTCOME_MESSAGES,
  writeAgentInstructions,
  type AgentInstructionsOutcome,
} from "../agents";
import { PublicCliError } from "../errors";

/**
 * Bring the files `topik init` writes for tools up to date with this CLI. Today that is the
 * Topik section of `AGENTS.md`. Project sources are never changed.
 */
export async function migrateProject(dir: string): Promise<AgentInstructionsOutcome> {
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
    console.log(AGENT_INSTRUCTIONS_OUTCOME_MESSAGES[await migrateProject(resolve(options.dir))]);
  },
});
