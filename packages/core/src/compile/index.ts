import { resolve } from "node:path";
import type { Resource } from "../resource";
import { findConfigFile } from "./config";
import { compileWiki, inspectWiki } from "./wiki";
import { compileGuides, inspectGuides } from "./guide";
import type { CompileResult, CompileValidationOptions } from "./shared";

export { compileWiki, pagePathToName } from "./wiki";
export type { CompileWikiOptions } from "./wiki";
export { compileGuides } from "./guide";
export type { CompileGuidesOptions } from "./guide";
export type { Resource } from "../resource";
export {
  CompileError,
  isErrorDiagnostic,
  type CompileResult,
  type CompileValidationOptions,
  type LinkValidationPolicy,
} from "./shared";

const WIKI_CONFIG_FILES = ["wiki.yaml", "wiki.yml", "wiki.json"];
const COLLECTION_CONFIG_FILES = ["collection.yaml", "collection.yml", "collection.json"];

export interface CompileOptions {
  dir: string;
  validation?: CompileValidationOptions;
}

export async function compile(options: CompileOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);
  const resources: Resource[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];

  const wikiConfig = await findConfigFile(dir, WIKI_CONFIG_FILES);
  if (wikiConfig) {
    const result = await compileWiki({ dir, validation: options.validation });
    resources.push(...result.resources);
    diagnostics.push(...result.diagnostics);
  }

  const collectionConfig = await findConfigFile(dir, COLLECTION_CONFIG_FILES);
  if (collectionConfig) {
    const result = await compileGuides({ dir, validation: options.validation });
    resources.push(...result.resources);
    diagnostics.push(...result.diagnostics);
  }

  return { diagnostics, resources };
}

export interface LintResult {
  diagnostics: CompileResult["diagnostics"];
}

export async function lint(options: CompileOptions): Promise<LintResult> {
  const dir = resolve(options.dir);
  const diagnostics: CompileResult["diagnostics"] = [];

  if (await findConfigFile(dir, WIKI_CONFIG_FILES)) {
    diagnostics.push(...(await inspectWiki({ dir, validation: options.validation })).diagnostics);
  }
  if (await findConfigFile(dir, COLLECTION_CONFIG_FILES)) {
    diagnostics.push(...(await inspectGuides({ dir, validation: options.validation })).diagnostics);
  }

  return { diagnostics };
}
