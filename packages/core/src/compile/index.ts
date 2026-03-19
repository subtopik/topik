import { resolve } from "node:path";
import type { Resource } from "../resource";
import { findConfigFile } from "./config";
import { compileWiki } from "./wiki";
import type { CompileResult } from "./wiki";

export { compileWiki } from "./wiki";
export type { CompileWikiOptions, CompileResult } from "./wiki";
export type { Resource } from "../resource";

const WIKI_CONFIG_FILES = ["wiki.yaml", "wiki.yml", "wiki.json"];

export interface CompileOptions {
  dir: string;
}

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
