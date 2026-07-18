import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertRegularFileWithinRoot, readRegularFileWithinRoot } from "./files";

export async function readConfigFile(dir: string, candidates: string[]): Promise<unknown> {
  const config = await readOptionalConfigFile(dir, candidates);
  if (config != null) {
    return config;
  }
  throw new Error(`Config file not found in ${dir} (tried ${candidates.join(", ")})`);
}

export async function readOptionalConfigFile(dir: string, candidates: string[]): Promise<unknown> {
  for (const name of candidates) {
    const filePath = join(dir, name);
    let raw: string;

    try {
      raw = await readRegularFileWithinRoot(filePath, dir, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read config file ${filePath}: ${message}`, { cause: error });
    }

    try {
      return name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch (error) {
      throw new Error(`Failed to parse config file ${filePath}`, { cause: error });
    }
  }
  return undefined;
}

export async function findConfigFile(dir: string, candidates: string[]): Promise<string | null> {
  for (const name of candidates) {
    try {
      await assertRegularFileWithinRoot(join(dir, name), dir);
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to access config file ${join(dir, name)}: ${message}`, {
        cause: error,
      });
    }
  }
  return null;
}
