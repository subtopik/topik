import Markdoc, { type Config, type RenderableTreeNode } from "@markdoc/markdoc";
import {
  assignTopikHeadingIds,
  parseTopikContent,
  removeInvalidTopikAssetReferences,
  removeInvalidTopikNavigationReferences,
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
  onAssetDiagnostic?: (diagnostic: TopikAssetResolutionDiagnostic) => void;
}

export interface TopikAssetResolutionDiagnostic {
  id: "TOPIK_ASSET_REFERENCE_MALFORMED" | "TOPIK_ASSET_REFERENCE_MISSING";
  message: string;
  name?: string;
  slot: "image.src" | "figure.src" | "figure.darkSrc" | "link.href";
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
  removeInvalidTopikAssetReferences(ast, content);
  removeInvalidTopikNavigationReferences(ast);
  assignTopikHeadingIds(ast);
  return Markdoc.transform(ast, mergeConfigs(topikMarkdocConfig, options.config));
}

export function renderTopikContent(
  tree: RenderableTreeNode,
  options: RenderTopikContentOptions = {},
): React.ReactNode {
  const resolved = resolveTopikAssetReferences(tree, options.resolveAsset, {
    onDiagnostic: options.onAssetDiagnostic,
  });
  return Markdoc.renderers.react(resolved, React, {
    components: getTopikComponents(options.components),
  });
}

interface ResolveTopikAssetReferencesOptions {
  onDiagnostic?: (diagnostic: TopikAssetResolutionDiagnostic) => void;
}

/** Resolve only schema-declared rendered Asset slots; arbitrary nested strings are untouched. */
export function resolveTopikAssetReferences<T>(
  value: T,
  resolveAsset?: TopikAssetResolver,
  options: ResolveTopikAssetReferencesOptions = {},
): T {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTopikAssetReferences(entry, resolveAsset, options)) as T;
  }
  if (!(value instanceof Markdoc.Tag)) return value;

  const attributes = { ...value.attributes };
  const slots = renderedAssetSlots(value.name);
  for (const [attribute, slot] of slots) {
    const reference = attributes[attribute];
    if (typeof reference !== "string" || !reference.startsWith("asset:")) continue;
    const name = reference.slice("asset:".length);
    if (
      !/^(?:(?!auto-v1-)[a-z0-9]+(?:-[a-z0-9]+)*|auto-v1-[a-z2-7]{52})$/u.test(name) ||
      name.length > 63
    ) {
      delete attributes[attribute];
      options.onDiagnostic?.({
        id: "TOPIK_ASSET_REFERENCE_MALFORMED",
        message: "Asset reference has an invalid name",
        slot,
      });
      continue;
    }
    let resolved: string | undefined;
    try {
      resolved = resolveAsset?.(name);
    } catch {
      resolved = undefined;
    }
    if (resolved === undefined || resolved.startsWith("asset:")) {
      delete attributes[attribute];
      options.onDiagnostic?.({
        id: "TOPIK_ASSET_REFERENCE_MISSING",
        message: "Asset name could not be resolved",
        name,
        slot,
      });
    } else {
      attributes[attribute] = resolved;
    }
  }
  return new Markdoc.Tag(
    value.name,
    attributes,
    value.children.map((child) => resolveTopikAssetReferences(child, resolveAsset, options)),
  ) as T;
}

function renderedAssetSlots(
  name: string,
): ReadonlyArray<readonly [string, TopikAssetResolutionDiagnostic["slot"]]> {
  if (name === "TopikImage") return [["src", "image.src"]];
  if (name === "TopikFigure") {
    return [
      ["src", "figure.src"],
      ["darkSrc", "figure.darkSrc"],
    ];
  }
  if (name === "TopikLink") return [["href", "link.href"]];
  return [];
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
