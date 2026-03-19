import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Read and parse a config file, supporting .yaml, .yml, and .json. */
export async function readConfigFile(dir: string, candidates: string[]): Promise<unknown> {
  for (const name of candidates) {
    const filePath = join(dir, name);
    try {
      await access(filePath);
      const raw = await readFile(filePath, "utf-8");
      return name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch {
      continue;
    }
  }
  throw new Error(`Config file not found in ${dir} (tried ${candidates.join(", ")})`);
}

export async function findConfigFile(dir: string, candidates: string[]): Promise<string | null> {
  for (const name of candidates) {
    try {
      await access(join(dir, name));
      return name;
    } catch {
      continue;
    }
  }
  return null;
}
