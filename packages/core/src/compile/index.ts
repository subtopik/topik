import { resolve } from "node:path";
import type { Resource } from "../resource";
import { findConfigFile } from "./config";
import { compileWiki, inspectWiki } from "./wiki";
import { compileGuides, inspectGuides } from "./guide";
import {
  TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
  type PortableAssetCompilationOptions,
} from "./assets";
import type { CompileResult, CompileValidationOptions } from "./shared";

export { compileWiki, pagePathToName } from "./wiki";
export type { CompileWikiOptions } from "./wiki";
export { compileGuides } from "./guide";
export type { CompileGuidesOptions } from "./guide";
export {
  compilePortableResourceArtifacts,
  PortableAssetCompilationError,
  TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
  type CompilePortableResourceArtifactsInput,
  type ContentBearingResource,
  type PortableAssetCompilationOptions,
  type PortableAssetKeyStateV1,
  type PortableResourceArtifact,
  type PortableResourceCompilationResult,
} from "./assets";
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
  assets?: PortableAssetCompilationOptions;
}

export async function compile(options: CompileOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);
  const resources: Resource[] = [];
  const artifacts: CompileResult["artifacts"] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  let assetKeyState =
    options.assets?.keyState ??
    ({
      version: TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
      keysByResource: {},
      retiredKeys: [],
    } as const);

  const wikiConfig = await findConfigFile(dir, WIKI_CONFIG_FILES);
  if (wikiConfig) {
    const result = await compileWiki({
      dir,
      validation: options.validation,
      assets: {
        keyState: assetKeyState,
        randomBytes: options.assets?.randomBytes,
        downloadableLinkPositionsByResource: options.assets?.downloadableLinkPositionsByResource,
      },
    });
    resources.push(...result.resources);
    artifacts.push(...result.artifacts);
    diagnostics.push(...result.diagnostics);
    assetKeyState = result.assetKeyState;
  }

  const collectionConfig = await findConfigFile(dir, COLLECTION_CONFIG_FILES);
  if (collectionConfig) {
    const result = await compileGuides({
      dir,
      validation: options.validation,
      assets: {
        keyState: assetKeyState,
        randomBytes: options.assets?.randomBytes,
        downloadableLinkPositionsByResource: options.assets?.downloadableLinkPositionsByResource,
      },
    });
    resources.push(...result.resources);
    artifacts.push(...result.artifacts);
    diagnostics.push(...result.diagnostics);
    assetKeyState = result.assetKeyState;
  }

  const roots = new Set(artifacts.map((artifact) => artifact.resourceRoot));
  if (roots.size !== artifacts.length) {
    throw new Error("Compiled portable resource output roots collide");
  }
  artifacts.sort((left, right) =>
    Buffer.compare(Buffer.from(left.resourceRoot), Buffer.from(right.resourceRoot)),
  );
  return { diagnostics, resources, artifacts, assetKeyState };
}

export interface LintResult {
  diagnostics: CompileResult["diagnostics"];
}

export async function lint(options: CompileOptions): Promise<LintResult> {
  const dir = resolve(options.dir);
  const diagnostics: CompileResult["diagnostics"] = [];

  if (await findConfigFile(dir, WIKI_CONFIG_FILES)) {
    diagnostics.push(
      ...(await inspectWiki({ dir, validation: options.validation, assets: options.assets }))
        .diagnostics,
    );
  }
  if (await findConfigFile(dir, COLLECTION_CONFIG_FILES)) {
    diagnostics.push(
      ...(await inspectGuides({ dir, validation: options.validation, assets: options.assets }))
        .diagnostics,
    );
  }

  return { diagnostics };
}
