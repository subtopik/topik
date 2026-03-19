import { resolve } from "node:path";
import { findConfigFile } from "./config";
import { compileWiki } from "./wiki";
import type { CompileResult, Resource } from "./wiki";

export { compileWiki, pagePathToName } from "./wiki";
export type { CompileWikiOptions, CompileResult, Resource } from "./wiki";

const WIKI_CONFIG_FILES = ["wiki.yaml", "wiki.yml", "wiki.json"];

export interface CompileOptions {
  /** Absolute path to the content directory */
  dir: string;
}

/** Compile all content in a directory by detecting config files. */
export async function compile(options: CompileOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);
  const resources: Resource[] = [];

  const wikiConfig = await findConfigFile(dir, WIKI_CONFIG_FILES);
  if (wikiConfig) {
    const result = await compileWiki({ dir });
    resources.push(...result.resources);
  }

  return { resources };
}
