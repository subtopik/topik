import Markdoc, { type Config, type RenderableTreeNode } from "@markdoc/markdoc";
import {
  parseTopikContent,
  topikMarkdocConfig,
  validateTopikContent,
  type TopikContentDiagnostic,
} from "@topik/content-schema";
import * as React from "react";
import {
  getTopikComponents,
  type TopikAssetResolver,
  type TopikComponentOverrides,
} from "./components";

export interface CompileTopikContentOptions {
  file?: string;
  config?: Config;
  validate?: boolean;
  onDiagnostic?: (diagnostic: TopikContentDiagnostic) => void;
}

export interface RenderTopikContentOptions {
  components?: TopikComponentOverrides;
  resolveAsset?: TopikAssetResolver;
}

export interface RenderTopikMarkdownOptions
  extends CompileTopikContentOptions, RenderTopikContentOptions {}

export function compileTopikContent(
  content: string,
  options: CompileTopikContentOptions = {},
): RenderableTreeNode {
  const shouldValidate = options.validate ?? true;

  if (shouldValidate) {
    const result = validateTopikContent(content, { file: options.file, config: options.config });
    for (const diagnostic of result.errors) options.onDiagnostic?.(diagnostic);
  }

  const ast = parseTopikContent(content, { file: options.file, location: shouldValidate });
  return Markdoc.transform(ast, mergeConfigs(topikMarkdocConfig, options.config));
}

export function renderTopikContent(
  tree: RenderableTreeNode,
  options: RenderTopikContentOptions = {},
): React.ReactNode {
  const resolvedTree = options.resolveAsset
    ? resolveTopikAssetReferences(tree, options.resolveAsset)
    : tree;

  return Markdoc.renderers.react(resolvedTree, React, {
    components: getTopikComponents(options.components),
  });
}

export function renderTopikMarkdown(
  content: string,
  options: RenderTopikMarkdownOptions = {},
): React.ReactNode {
  return renderTopikContent(compileTopikContent(content, options), options);
}

export function resolveTopikAssetReferences<T>(value: T, resolveAsset: TopikAssetResolver): T {
  if (typeof value === "string") {
    return (value.startsWith("asset:") ? resolveAsset(value.slice("asset:".length)) : value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTopikAssetReferences(item, resolveAsset)) as T;
  }

  if (value === null || typeof value !== "object") return value;

  const entries = Object.entries(value).map(([key, nestedValue]) => [
    key,
    resolveTopikAssetReferences(nestedValue, resolveAsset),
  ]);

  return Object.fromEntries(entries) as T;
}

function mergeConfigs(base: Config, override: Config = {}): Config {
  return {
    ...base,
    ...override,
    nodes: { ...base.nodes, ...override.nodes },
    tags: { ...base.tags, ...override.tags },
    variables: { ...base.variables, ...override.variables },
    functions: { ...base.functions, ...override.functions },
    partials: { ...base.partials, ...override.partials },
    validation: { ...base.validation, ...override.validation },
  };
}
