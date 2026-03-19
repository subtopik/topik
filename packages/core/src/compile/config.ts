import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export async function readConfigFile(dir: string, candidates: string[]): Promise<unknown> {
  for (const name of candidates) {
    const filePath = join(dir, name);
    let raw: string;

    try {
      raw = await readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw new Error(`Failed to read config file ${filePath}`, { cause: error });
    }

    try {
      return name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch (error) {
      throw new Error(`Failed to parse config file ${filePath}`, { cause: error });
    }
  }
  throw new Error(`Config file not found in ${dir} (tried ${candidates.join(", ")})`);
}

export async function findConfigFile(dir: string, candidates: string[]): Promise<string | null> {
  for (const name of candidates) {
    try {
      await access(join(dir, name));
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw new Error(`Failed to access config file ${join(dir, name)}`, { cause: error });
    }
  }
  return null;
}
