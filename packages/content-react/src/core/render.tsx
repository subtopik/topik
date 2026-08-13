import Markdoc, { type Config, type RenderableTreeNode } from "@markdoc/markdoc";
import {
  assignTopikHeadingIds,
  extractTopikAssetOccurrences,
  mergeTopikMarkdocConfig,
  parseTopikContent,
  removeInvalidTopikAssetReferences,
  removeInvalidTopikNavigationReferences,
  sanitizeTopikContentDiagnostic,
  validateTopikAssetReference,
  validateTopikContent,
  validateTopikHref,
  validateTopikNavigationHref,
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
  onDiagnostic?: (diagnostic: TopikContentDiagnostic) => void;
}

export interface RenderTrustedTopikTreeOptions {
  components?: TopikComponentOverrides;
  resolveAsset?: TopikAssetResolver;
  onAssetDiagnostic?: (diagnostic: TopikAssetResolutionDiagnostic) => void;
  onNavigationDiagnostic?: (diagnostic: TopikNavigationResolutionDiagnostic) => void;
}

export interface RenderTopikContentOptions extends RenderTrustedTopikTreeOptions {
  onDiagnostic?: (diagnostic: TopikContentDiagnostic) => void;
  invalidContent?: "placeholder";
  invalidContentPlaceholder?: React.ComponentType;
}

export interface CompileTopikContentSuccess {
  ok: true;
  /** Exact caller-supplied source. */
  source: string;
  diagnostics: TopikContentDiagnostic[];
  tree: RenderableTreeNode;
}

export interface CompileTopikContentFailure {
  ok: false;
  /** Exact caller-supplied source, unchanged and never transformed. */
  source: string;
  diagnostics: TopikContentDiagnostic[];
}

export type CompileTopikContentResult = CompileTopikContentSuccess | CompileTopikContentFailure;

export class InvalidTopikContentError extends Error {
  constructor(public readonly result: CompileTopikContentFailure) {
    super("Topik content is unsupported or invalid");
    this.name = "InvalidTopikContentError";
  }
}

export interface TopikAssetResolutionDiagnostic {
  id: "TOPIK_ASSET_REFERENCE_MALFORMED" | "TOPIK_ASSET_REFERENCE_MISSING";
  message: string;
  name?: string;
  slot: "image.src" | "figure.src" | "figure.darkSrc" | "link.href";
}

export interface TopikNavigationResolutionDiagnostic {
  id: "TOPIK_NAVIGATION_REFERENCE_UNSAFE";
  message: string;
  slot: "card.href";
}

export interface RenderTopikMarkdownOptions
  extends CompileTopikContentOptions, RenderTopikContentOptions {}

export function compileTopikContent(
  content: string,
  options: CompileTopikContentOptions = {},
): CompileTopikContentResult {
  return compileTopikContentInternal(content, options);
}

function compileTopikContentInternal(
  content: string,
  options: CompileTopikContentOptions & Pick<RenderTopikContentOptions, "onAssetDiagnostic">,
): CompileTopikContentResult {
  let configSnapshot: Config | undefined;
  let transformConfig: Config;
  try {
    configSnapshot =
      options.config === undefined ? undefined : mergeTopikMarkdocConfig(options.config);
    transformConfig = configSnapshot ?? mergeTopikMarkdocConfig();
  } catch {
    const diagnostic = transformDiagnostic(options.file, "topik-config-invalid");
    options.onDiagnostic?.(diagnostic);
    return { ok: false, source: content, diagnostics: [diagnostic] };
  }
  const validation = validateTopikContent(content, {
    file: options.file,
    config: configSnapshot,
    allowCompiledAssetReferences: true,
  });
  for (const diagnostic of validation.errors) options.onDiagnostic?.(diagnostic);
  if (!validation.valid) {
    return { ok: false, source: content, diagnostics: validation.errors };
  }

  const ast = parseTopikContent(content, { file: options.file, location: true });
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
  try {
    return {
      ok: true,
      source: content,
      diagnostics: validation.errors,
      tree: Markdoc.transform(ast, transformConfig),
    };
  } catch {
    const diagnostic = transformDiagnostic(options.file, "topik-transform-failed");
    options.onDiagnostic?.(diagnostic);
    return {
      ok: false,
      source: content,
      diagnostics: [...validation.errors, diagnostic],
    };
  }
}

function transformDiagnostic(
  file: string | undefined,
  id: "topik-config-invalid" | "topik-transform-failed",
): TopikContentDiagnostic {
  return sanitizeTopikContentDiagnostic({
    id,
    type: "document",
    level: "critical",
    message: "",
    lines: [],
    ...(file === undefined ? {} : { file }),
  });
}

export function renderTopikContent(
  result: CompileTopikContentResult,
  options: RenderTopikContentOptions = {},
): React.ReactNode {
  if (!result.ok) {
    for (const diagnostic of result.diagnostics) options.onDiagnostic?.(diagnostic);
    if (options.invalidContent === "placeholder") {
      return renderInvalidTopikContent(options.invalidContentPlaceholder);
    }
    throw new InvalidTopikContentError(result);
  }
  return renderTrustedTopikTree(result.tree, options);
}

/**
 * Render a caller-trusted Markdoc tree. The caller owns validation and this API remains separate
 * from normal source rendering. Post-transform link and Asset sanitization still applies.
 */
export function renderTrustedTopikTree(
  tree: RenderableTreeNode,
  options: RenderTrustedTopikTreeOptions = {},
): React.ReactNode {
  const resolved = resolveTopikAssetReferences(tree, options.resolveAsset, {
    onDiagnostic: options.onAssetDiagnostic,
    onNavigationDiagnostic: options.onNavigationDiagnostic,
  });
  return Markdoc.renderers.react(resolved, React, {
    components: getTopikComponents(options.components),
  });
}

function renderInvalidTopikContent(Placeholder: React.ComponentType | undefined): React.ReactNode {
  return (
    <div role="alert">
      {Placeholder === undefined ? "Unsupported or invalid Topik content" : <Placeholder />}
    </div>
  );
}

interface ResolveTopikAssetReferencesOptions {
  onDiagnostic?: (diagnostic: TopikAssetResolutionDiagnostic) => void;
  onNavigationDiagnostic?: (diagnostic: TopikNavigationResolutionDiagnostic) => void;
}

/** Resolve and sanitize only schema-declared browser-facing references. */
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
  const slots = renderedReferenceSlots(value.name);
  for (const definition of slots) {
    const { attribute } = definition;
    if (!Object.hasOwn(attributes, attribute)) continue;
    const reference = attributes[attribute];
    if (definition.kind === "navigation") {
      if (
        typeof reference !== "string" ||
        usesReservedAssetScheme(reference) ||
        validateTopikNavigationHref(reference).length > 0
      ) {
        delete attributes[attribute];
        options.onNavigationDiagnostic?.({
          id: "TOPIK_NAVIGATION_REFERENCE_UNSAFE",
          message: "Card navigation target is unsafe or invalid",
          slot: definition.slot,
        });
      }
      continue;
    }
    const { slot } = definition;
    if (typeof reference !== "string") {
      delete attributes[attribute];
      malformedReference(options, slot);
      continue;
    }
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
    const validation = validateTopikAssetReference(reference);
    if (!validation.valid || validation.kind !== "asset") {
      delete attributes[attribute];
      malformedReference(options, slot);
      continue;
    }
    const generatedName = validation.name;
    let resolved: string | undefined;
    try {
      resolved = resolveAsset?.(generatedName);
    } catch {
      resolved = undefined;
    }
    if (
      typeof resolved !== "string" ||
      usesReservedAssetScheme(resolved) ||
      !isSafeResolvedAssetReference(resolved)
    ) {
      delete attributes[attribute];
      options.onDiagnostic?.({
        id: "TOPIK_ASSET_REFERENCE_MISSING",
        message: "Asset name could not be resolved",
        name: generatedName,
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

type RenderedReferenceSlot =
  | {
      kind: "asset";
      attribute: string;
      slot: TopikAssetResolutionDiagnostic["slot"];
    }
  | {
      kind: "navigation";
      attribute: "href";
      slot: TopikNavigationResolutionDiagnostic["slot"];
    };

/** Closed registry for every canonical browser-facing URL or Asset attribute. */
function renderedReferenceSlots(name: string): readonly RenderedReferenceSlot[] {
  if (name === "TopikCard") return [{ kind: "navigation", attribute: "href", slot: "card.href" }];
  if (name === "TopikImage") return [{ kind: "asset", attribute: "src", slot: "image.src" }];
  if (name === "TopikFigure") {
    return [
      { kind: "asset", attribute: "src", slot: "figure.src" },
      { kind: "asset", attribute: "darkSrc", slot: "figure.darkSrc" },
    ];
  }
  if (name === "TopikLink") {
    return [{ kind: "asset", attribute: "href", slot: "link.href" }];
  }
  return [];
}

export function renderTopikMarkdown(
  content: string,
  options: RenderTopikMarkdownOptions = {},
): React.ReactNode {
  const result = compileTopikContentInternal(content, options);
  return renderTopikContent(result, { ...options, onDiagnostic: undefined });
}
