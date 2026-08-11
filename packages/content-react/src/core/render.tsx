import Markdoc, { type Config, type RenderableTreeNode } from "@markdoc/markdoc";
import {
  assignTopikHeadingIds,
  extractTopikAssetOccurrences,
  parseTopikContent,
  removeInvalidTopikAssetReferences,
  removeInvalidTopikNavigationReferences,
  topikMarkdocConfig,
  validateTopikAssetReference,
  validateTopikContent,
  validateTopikHref,
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
  return compileTopikContentInternal(content, options);
}

function compileTopikContentInternal(
  content: string,
  options: CompileTopikContentOptions & Pick<RenderTopikContentOptions, "onAssetDiagnostic">,
): RenderableTreeNode {
  const shouldValidate = options.validate ?? true;

  if (shouldValidate) {
    const result = validateTopikContent(content, {
      file: options.file,
      config: options.config,
      allowCompiledAssetReferences: true,
    });
    for (const diagnostic of result.errors) options.onDiagnostic?.(diagnostic);
  }

  const ast = parseTopikContent(content, { file: options.file, location: shouldValidate });
  for (const occurrence of extractTopikAssetOccurrences(content)) {
    if (occurrence.kind !== "reserved-asset") continue;
    options.onAssetDiagnostic?.({
      id: "TOPIK_ASSET_REFERENCE_MALFORMED",
      message: "Asset reference has an invalid name",
      slot: occurrence.slot,
    });
  }
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
    if (typeof reference !== "string") continue;
    if (!usesReservedAssetScheme(reference)) {
      if (!isSafeRenderedReference(reference, slot)) {
        delete attributes[attribute];
        malformedReference(options, slot);
      }
      continue;
    }
    if (!reference.startsWith("asset:")) {
      delete attributes[attribute];
      malformedReference(options, slot);
      continue;
    }
    const name = reference.slice("asset:".length);
    if (!/^auto-v1-[a-z2-7]{52}$/u.test(name)) {
      delete attributes[attribute];
      malformedReference(options, slot);
      continue;
    }
    let resolved: string | undefined;
    try {
      resolved = resolveAsset?.(name);
    } catch {
      resolved = undefined;
    }
    if (
      resolved === undefined ||
      usesReservedAssetScheme(resolved) ||
      !isSafeResolvedAssetReference(resolved)
    ) {
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

function malformedReference(
  options: ResolveTopikAssetReferencesOptions,
  slot: TopikAssetResolutionDiagnostic["slot"],
): void {
  options.onDiagnostic?.({
    id: "TOPIK_ASSET_REFERENCE_MALFORMED",
    message: "Asset reference has an invalid name or unsafe location",
    slot,
  });
}

function isSafeRenderedReference(
  reference: string,
  slot: TopikAssetResolutionDiagnostic["slot"],
): boolean {
  const validation = validateTopikAssetReference(reference);
  if (validation.valid) return true;
  if (slot !== "link.href") return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(reference)?.[1].toLowerCase();
  if (scheme !== undefined && scheme !== "mailto" && scheme !== "tel") return false;
  return validateTopikHref(reference).length === 0;
}

function isSafeResolvedAssetReference(reference: string): boolean {
  const validation = validateTopikAssetReference(reference);
  if (validation.valid && validation.kind !== "asset") return true;
  if (reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(reference)) return false;
  return validateTopikHref(reference).length === 0;
}

function usesReservedAssetScheme(value: string): boolean {
  let prefix = "";
  for (let index = 0; index < value.length && prefix.length < "asset:".length; index++) {
    if (value[index] === "%" && /^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      prefix += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    if (value[index] === "&") {
      const entity = /^(?:&#0*58;|&#x0*3a;|&colon;)/iu.exec(value.slice(index));
      if (entity !== null) {
        prefix += ":";
        index += entity[0].length - 1;
        continue;
      }
    }
    prefix += value[index];
  }
  return /^asset:/iu.test(prefix);
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
  return renderTopikContent(compileTopikContentInternal(content, options), options);
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
