import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertRegularFileWithinRoot, readRegularFileWithinRoot } from "./files";
import { PublicCompileError } from "./public-errors";

export async function readConfigFile(dir: string, candidates: string[]): Promise<unknown> {
  const config = await readOptionalConfigFile(dir, candidates);
  if (config != null) {
    return config;
  }
  throw new PublicCompileError("config-not-found");
}

export async function readOptionalConfigFile(dir: string, candidates: string[]): Promise<unknown> {
  return (await readOptionalConfigFileWithPath(dir, candidates))?.value;
}

export async function readOptionalConfigFileWithPath(
  dir: string,
  candidates: string[],
): Promise<{ path: string; value: unknown } | undefined> {
  for (const name of candidates) {
    const filePath = join(dir, name);
    let raw: string;

    try {
      raw = await readRegularFileWithinRoot(filePath, dir, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw new PublicCompileError("config-read-failed", name);
    }

    try {
      return { path: name, value: name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw) };
    } catch {
      throw new PublicCompileError("config-parse-failed", name);
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
      throw new PublicCompileError("config-access-failed", name);
    }
  }
  return null;
}
