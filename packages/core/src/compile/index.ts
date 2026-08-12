import { resolve } from "node:path";
import type { SourceResource } from "../resource";
import { findConfigFile } from "./config";
import { discoverWiki } from "./wiki";
import { discoverGuides } from "./guide";
import { compileAssetResources, type AssetCompilationOptions } from "./assets";
import {
  CompileError,
  throwOnCompileErrors,
  type CompileResult,
  type CompileValidationOptions,
} from "./shared";

export { compileWiki, pagePathToName } from "./wiki";
export type { CompileWikiOptions } from "./wiki";
export { compileGuides } from "./guide";
export type { CompileGuidesOptions } from "./guide";
export {
  compileAssetResources,
  AssetCompilationError,
  type AssetCompilationOptions,
  type AssetCompilationResult,
  type AssetPayload,
  type CompileAssetResourcesInput,
  type ContentBearingResource,
} from "./assets";
export type { Resource } from "../resource";
export {
  CompileError,
  isErrorDiagnostic,
  type CompileResult,
  type CompileValidationOptions,
  type LinkValidationPolicy,
} from "./shared";
export {
  publicCompileErrorMessage,
  PublicCompileError,
  type PublicCompileErrorId,
} from "./public-errors";

const WIKI_CONFIG_FILES = ["wiki.yaml", "wiki.yml", "wiki.json"];
const COLLECTION_CONFIG_FILES = ["collection.yaml", "collection.yml", "collection.json"];

export interface CompileOptions {
  dir: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
}

export async function compile(options: CompileOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);
  const resources: SourceResource[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const sourcePathsByResource: Record<string, string> = {};
  const protectedSourcePaths: string[] = [];

  const wikiConfig = await findConfigFile(dir, WIKI_CONFIG_FILES);
  if (wikiConfig) {
    const result = await discoverWiki({ dir, validation: options.validation });
    resources.push(...result.resources);
    diagnostics.push(...result.diagnostics);
    Object.assign(sourcePathsByResource, result.sourcePathsByResource);
    protectedSourcePaths.push(...result.consumedSourcePaths);
  }

  const collectionConfig = await findConfigFile(dir, COLLECTION_CONFIG_FILES);
  if (collectionConfig) {
    const result = await discoverGuides({ dir, validation: options.validation });
    resources.push(...result.resources);
    diagnostics.push(...result.diagnostics);
    Object.assign(sourcePathsByResource, result.sourcePathsByResource);
    protectedSourcePaths.push(...result.consumedSourcePaths);
  }

  throwOnCompileErrors(diagnostics);
  const compiled = await compileAssetResources({
    rootDir: dir,
    resources,
    sourcePathsByResource,
    protectedSourcePaths,
    ...options.assets,
  });
  return { diagnostics, ...compiled };
}

export interface LintResult {
  diagnostics: CompileResult["diagnostics"];
}

export async function lint(options: CompileOptions): Promise<LintResult> {
  try {
    return { diagnostics: (await compile(options)).diagnostics };
  } catch (error) {
    if (error instanceof CompileError) return { diagnostics: error.diagnostics };
    throw error;
  }
}
