import Markdoc, { type Config, type RenderableTreeNode } from "@markdoc/markdoc";
import {
  assignTopikHeadingIds,
  parseTopikContent,
  topikMarkdocConfig,
  validateTopikContent,
  type TopikContentDiagnostic,
} from "@topik/content-schema";
import * as React from "react";
import { getTopikComponents, type TopikComponentOverrides } from "./components";

export interface CompileTopikContentOptions {
  file?: string;
  config?: Config;
  validate?: boolean;
  onDiagnostic?: (diagnostic: TopikContentDiagnostic) => void;
}

export interface RenderTopikContentOptions {
  components?: TopikComponentOverrides;
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
  assignTopikHeadingIds(ast);
  return Markdoc.transform(ast, mergeConfigs(topikMarkdocConfig, options.config));
}

export function renderTopikContent(
  tree: RenderableTreeNode,
  options: RenderTopikContentOptions = {},
): React.ReactNode {
  return Markdoc.renderers.react(tree, React, {
    components: getTopikComponents(options.components),
  });
}

export function renderTopikMarkdown(
  content: string,
  options: RenderTopikMarkdownOptions = {},
): React.ReactNode {
  return renderTopikContent(compileTopikContent(content, options), options);
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
