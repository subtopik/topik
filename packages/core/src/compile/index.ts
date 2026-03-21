import { resolve } from "node:path";
import type { Resource } from "../resource";
import { findConfigFile } from "./config";
import { compileWiki } from "./wiki";
import { compileGuides } from "./guide";
import type { CompileResult } from "./shared";

export { compileWiki } from "./wiki";
export type { CompileWikiOptions } from "./wiki";
export { compileGuides } from "./guide";
export type { CompileGuidesOptions } from "./guide";
export type { Resource } from "../resource";
export type { CompileResult } from "./shared";

const WIKI_CONFIG_FILES = ["wiki.yaml", "wiki.yml", "wiki.json"];
const COLLECTION_CONFIG_FILES = ["collection.yaml", "collection.yml", "collection.json"];

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

  const collectionConfig = await findConfigFile(dir, COLLECTION_CONFIG_FILES);
  if (collectionConfig) {
    const result = await compileGuides({ dir });
    resources.push(...result.resources);
  }

  return { resources };
}
