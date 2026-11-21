import { lstat, mkdir, open, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { command, positional, string } from "@drizzle-team/brocli";
import { parseTopikManifest, TOPIK_MANIFEST_FILENAME } from "@topik/core";
import { stringify } from "yaml";
import {
  AGENT_INSTRUCTIONS_FILENAME,
  AGENT_INSTRUCTIONS_OUTCOME_MESSAGES,
  writeAgentInstructions,
  type AgentInstructionsOutcome,
} from "../agents";
import { PublicCliError } from "../errors";

const WIKI_CONFIG_FILENAME = "wiki.yaml";
const INDEX_PAGE_FILENAME = "index.md";

/** Defaults match the "Compile a wiki" example in docs/resources/index.md. */
export const INIT_DEFAULTS = Object.freeze({
  namespace: "example/handbook",
  id: "handbook",
  title: "Handbook",
});

/** Already in `topik format` output form, so a fresh project passes `topik format --check`. */
const INDEX_PAGE = `# Handbook

Write [Topik Markdown](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md) here, then run \`topik compile --validate\`.
`;

export interface InitProjectOptions {
  namespace?: string;
}

/** The scaffold's files in creation order, after validating the namespace with core's parser. */
export function initProjectFiles(options: InitProjectOptions = {}): [string, string][] {
  const manifest = {
    version: 1,
    namespace: options.namespace ?? INIT_DEFAULTS.namespace,
    sources: [{ kind: "wiki", config: WIKI_CONFIG_FILENAME }],
  };
  const wiki = { id: INIT_DEFAULTS.id, title: INIT_DEFAULTS.title, navigation: ["index"] };
  try {
    parseTopikManifest(manifest);
  } catch {
    throw new PublicCliError("init-namespace-invalid");
  }

  return [
    [TOPIK_MANIFEST_FILENAME, stringify(manifest)],
    [WIKI_CONFIG_FILENAME, stringify(wiki)],
    [INDEX_PAGE_FILENAME, INDEX_PAGE],
  ];
}

/**
 * Create the project files in `dir`, creating the directory if needed. Nothing is written when
 * any of the files already exists, and each file is opened exclusively (`wx`), so a file that
 * appears meanwhile, or a symbolic link in its place, is never followed or replaced.
 *
 * `AGENTS.md` comes last and follows its own rule, because projects often have one already:
 * a missing file is created, the Topik section of an existing one is updated, and any other
 * existing file is kept. `created` includes it only when this call created it.
 */
export async function initProject(
  dir: string,
  options: InitProjectOptions = {},
): Promise<{ created: string[]; agentInstructions: AgentInstructionsOutcome }> {
  const files = initProjectFiles(options);
  // The first directory this call created, if any; rollback removes what it created.
  const firstCreated = await mkdir(dir, { recursive: true }).catch(() => {
    throw new PublicCliError("init-target-access-failed");
  });
  const info = await stat(dir).catch(() => undefined);
  if (info?.isDirectory() !== true) throw new PublicCliError("init-target-access-failed");

  for (const [name] of files) {
    if (await exists(join(dir, name))) throw new PublicCliError("init-file-exists");
  }

  const created: string[] = [];
  let agentInstructions: AgentInstructionsOutcome;
  try {
    for (const [name, content] of files) {
      const handle = await open(join(dir, name), "wx");
      // Recorded once it exists, so a failed write below is rolled back too.
      created.push(name);
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    }
    // An AGENTS.md that is already there is kept: only the section Topik owns is updated.
    agentInstructions = await writeAgentInstructions(dir);
    if (agentInstructions === "created") created.push(AGENT_INSTRUCTIONS_FILENAME);
  } catch (error) {
    // Leave the directory as it was: remove only files and directories this run created.
    for (const name of created) await unlink(join(dir, name)).catch(() => undefined);
    if (firstCreated !== undefined) await removeCreatedDirectories(dir, firstCreated);
    throw new PublicCliError(
      (error as NodeJS.ErrnoException).code === "EEXIST" ? "init-file-exists" : "init-write-failed",
      { cause: error },
    );
  }
  return { created, agentInstructions };
}

/** Remove `dir` and its parents up to `first`, each only while it is empty. */
async function removeCreatedDirectories(dir: string, first: string): Promise<void> {
  for (let current = dir; ; current = dirname(current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    if (current === first || dirname(current) === current) return;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new PublicCliError("init-target-access-failed", { cause: error });
  }
}

export const init = command({
  name: "init",
  desc: "Create a minimal Topik wiki project (.topik.yaml, wiki.yaml, index.md, AGENTS.md)",
  options: {
    dir: positional("dir").desc("Directory to create the project in").default("."),
    namespace: string("namespace")
      .desc("Project namespace in .topik.yaml")
      .default(INIT_DEFAULTS.namespace),
  },
  handler: async (options) => {
    const { created, agentInstructions } = await initProject(resolve(options.dir), {
      namespace: options.namespace,
    });
    console.log(`Created ${created.join(", ")}`);
    if (agentInstructions !== "created") {
      console.log(AGENT_INSTRUCTIONS_OUTCOME_MESSAGES[agentInstructions]);
    }
    console.log("Next: run topik compile --validate in the project directory");
  },
});
