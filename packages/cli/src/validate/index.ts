import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, positional } from "@drizzle-team/brocli";
import { validateResources, type Resource } from "@topik/core";

async function loadResources(path: string): Promise<Resource[]> {
  const info = await stat(path);

  if (info.isFile()) {
    const content = await readFile(path, "utf-8");
    return [JSON.parse(content) as Resource];
  }

  // Directory: recursively collect all JSON files
  const entries = await readdir(path, { withFileTypes: true, recursive: true });
  const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".json"));

  const contents = await Promise.all(
    jsonFiles.map((e) => readFile(join(e.parentPath, e.name), "utf-8")),
  );

  return contents.map((c) => JSON.parse(c) as Resource);
}

export const validate = command({
  name: "validate",
  desc: "Validate topik resource files against schemas",
  options: {
    path: positional("path").desc("File or directory to validate").required(),
  },
  handler: async (options) => {
    const target = resolve(options.path);
    const resources = await loadResources(target);

    if (resources.length === 0) {
      console.log("No resource files found.");
      return;
    }

    const { valid, errors } = validateResources(resources);

    if (valid) {
      console.log(`Validated ${resources.length} resources`);
    } else {
      for (const err of errors) {
        console.error(`${err.resource}: ${err.path} ${err.message}`);
      }
      console.error(`\n${errors.length} validation error(s) in ${resources.length} resources`);
      process.exit(1);
    }
  },
});
