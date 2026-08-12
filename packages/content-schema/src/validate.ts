import Markdoc, { type Config, type Node } from "@markdoc/markdoc";
import {
  canonicalTopikValidationConfig,
  isolateTopikMarkdocValue,
  mergeTopikMarkdocConfig,
} from "./config";
import { parseTopikContent } from "./content";
import {
  sanitizeTopikContentDiagnostic,
  toTopikContentDiagnostic,
  type TopikContentDiagnostic,
} from "./diagnostics";
import {
  extractTopikAssetOccurrences,
  type TopikAssetOccurrence,
  validateTopikAssetReference,
} from "./asset-references";
import { validateTopikHref } from "./links";

export interface ValidateTopikContentOptions {
  /** Source file path used in Markdoc locations and diagnostics. */
  file?: string;
  /** Additive Markdoc config; canonical Topik node and tag schemas retain precedence. */
  config?: Config;
  /** Permit compiler-produced `asset:auto-v1-*` references at an output-consumer boundary. */
  allowCompiledAssetReferences?: boolean;
}

export interface ValidateTopikContentResult {
  /** Exact caller-supplied source. This field is intentionally not diagnostic text. */
  source: string;
  valid: boolean;
  errors: TopikContentDiagnostic[];
}

export function validateTopikContent(
  source: string,
  options: ValidateTopikContentOptions = {},
): ValidateTopikContentResult {
  let isolatedConfig: Config;
  try {
    isolatedConfig = mergeTopikMarkdocConfig(options.config);
  } catch {
    return validationResult(source, [configDiagnostic(options.file)]);
  }
  const canonicalAst = parseTopikContent(source, { file: options.file, location: true });
  const canonicalMarkdocErrors = Markdoc.validate(
    canonicalAst,
    canonicalTopikValidationConfig(canonicalAst, isolatedConfig),
  );
  const assetOccurrences = extractTopikAssetOccurrences(source);
  const unsafeHttpLinkOccurrences = extractTopikAssetOccurrences(source, {
    includeGenericLinkCandidates: true,
  }).filter(
    (occurrence) =>
      occurrence.slot === "link.href" &&
      occurrence.kind === "unsafe" &&
      /^https?:/iu.test(occurrence.parsedReference),
  );
  const canonicalErrors = uniqueDiagnostics(
    [
      ...validateOwnRegistryReferences(canonicalAst, isolatedConfig),
      ...canonicalMarkdocErrors.map(toTopikContentDiagnostic),
      ...validatePartialClosure(canonicalAst, isolatedConfig, (partialRoot, scopedConfig) => [
        ...validateOwnRegistryReferences(partialRoot, scopedConfig),
        ...Markdoc.validate(
          partialRoot,
          canonicalTopikValidationConfig(partialRoot, scopedConfig),
        ).map(toTopikContentDiagnostic),
        ...validatePartialAssetReferences(
          partialRoot,
          options.allowCompiledAssetReferences === true,
        ),
      ]),
      ...[...assetOccurrences, ...unsafeHttpLinkOccurrences].flatMap(
        (occurrence): TopikContentDiagnostic[] => {
          const reference = effectiveExternalReference(occurrence);
          const validation = validateTopikAssetReference(reference);
          const compiledAsset = validation.valid && validation.kind === "asset";
          if (
            validation.valid &&
            (occurrence.kind !== "unsafe" || reference !== occurrence.reference) &&
            (!compiledAsset || options.allowCompiledAssetReferences === true)
          ) {
            return [];
          }
          const namedReference =
            occurrence.kind === "asset" || occurrence.kind === "reserved-asset";
          const external = validation.valid
            ? validation.kind === "external-https"
            : validation.failureKind === "external";
          return [
            {
              id: namedReference
                ? "TOPIK_ASSET_REFERENCE_MALFORMED"
                : external
                  ? "TOPIK_EXTERNAL_REFERENCE_UNSAFE"
                  : "TOPIK_ASSET_PATH_INVALID",
              type: occurrence.slot,
              level: "error",
              message: namedReference
                ? compiledAsset
                  ? "Compiler-generated Asset references are not valid authoring input"
                  : "Asset reference has an invalid generated name"
                : external
                  ? "Asset reference requires credential-free HTTPS"
                  : "Local asset reference is not canonical topik-asset-reference-v1",
              lines: [],
              ...(options.file === undefined ? {} : { file: options.file }),
            },
          ];
        },
      ),
    ].map(sanitizeTopikContentDiagnostic),
  );
  if (hasBlockingDiagnostics(canonicalErrors) || options.config === undefined) {
    return validationResult(source, canonicalErrors);
  }

  const extensionAst = parseTopikContent(source, { file: options.file, location: true });
  let extensionErrors: TopikContentDiagnostic[];
  try {
    extensionErrors = [
      ...Markdoc.validate(extensionAst, mergeTopikMarkdocConfig(isolatedConfig)).map(
        toTopikContentDiagnostic,
      ),
      ...validatePartialClosure(
        parseTopikContent(source, { file: options.file, location: true }),
        mergeTopikMarkdocConfig(isolatedConfig),
        (partialRoot, scopedConfig) =>
          Markdoc.validate(
            isolateTopikMarkdocValue(partialRoot),
            mergeTopikMarkdocConfig(scopedConfig),
          ).map(toTopikContentDiagnostic),
      ),
    ];
  } catch {
    extensionErrors = [extensionDiagnostic(options.file)];
  }
  return validationResult(source, uniqueDiagnostics([...canonicalErrors, ...extensionErrors]));
}

function validateOwnRegistryReferences(root: Node, config: Config): TopikContentDiagnostic[] {
  const diagnostics: TopikContentDiagnostic[] = [];
  const seenValues = new WeakSet<object>();
  const visitValue = (value: unknown, node: Node): void => {
    if (Markdoc.Ast.isFunction(value)) {
      if (
        !Object.hasOwn(config.functions ?? {}, value.name) &&
        !Object.hasOwn(Markdoc.functions, value.name)
      ) {
        diagnostics.push(registryDiagnostic("function-undefined", node));
      }
      for (const nested of Object.values(value.parameters)) visitValue(nested, node);
      return;
    }
    if (Markdoc.Ast.isVariable(value) || value === null || typeof value !== "object") return;
    if (seenValues.has(value)) return;
    seenValues.add(value);
    for (const nested of Array.isArray(value) ? value : Object.values(value)) {
      visitValue(nested, node);
    }
  };

  for (const node of [root, ...root.walk()]) {
    const registered = node.tag
      ? Object.hasOwn(config.tags ?? {}, node.tag) || Object.hasOwn(Markdoc.tags, node.tag)
      : Object.hasOwn(config.nodes ?? {}, node.type) || Object.hasOwn(Markdoc.nodes, node.type);
    if (!registered)
      diagnostics.push(registryDiagnostic(node.tag ? "tag-undefined" : "node-undefined", node));
    for (const value of [...Object.values(node.attributes), ...node.annotations]) {
      visitValue(value, node);
    }
  }
  return diagnostics;
}

function registryDiagnostic(
  id: "function-undefined" | "node-undefined" | "tag-undefined",
  node: Node,
): TopikContentDiagnostic {
  return sanitizeTopikContentDiagnostic({
    id,
    type: node.type,
    level: "critical",
    message: "",
    lines: node.lines,
    ...(node.location?.file === undefined ? {} : { file: node.location.file }),
  });
}

function configDiagnostic(file: string | undefined): TopikContentDiagnostic {
  return sanitizeTopikContentDiagnostic({
    id: "topik-config-invalid",
    type: "document",
    level: "critical",
    message: "",
    lines: [],
    ...(file === undefined ? {} : { file }),
  });
}

function extensionDiagnostic(file: string | undefined): TopikContentDiagnostic {
  return sanitizeTopikContentDiagnostic({
    id: "topik-extension-failed",
    type: "document",
    level: "critical",
    message: "",
    lines: [],
    ...(file === undefined ? {} : { file }),
  });
}

function validationResult(
  source: string,
  errors: TopikContentDiagnostic[],
): ValidateTopikContentResult {
  return {
    source,
    valid: !hasBlockingDiagnostics(errors),
    errors,
  };
}

function hasBlockingDiagnostics(errors: TopikContentDiagnostic[]): boolean {
  return errors.some(
    (diagnostic) => diagnostic.level === "error" || diagnostic.level === "critical",
  );
}

function uniqueDiagnostics(errors: TopikContentDiagnostic[]): TopikContentDiagnostic[] {
  const seen = new Set<string>();
  return errors.filter((diagnostic) => {
    const key = JSON.stringify([
      diagnostic.id,
      diagnostic.type,
      diagnostic.level,
      diagnostic.message,
      diagnostic.lines,
      diagnostic.file,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validatePartialClosure(
  root: Node,
  config: Config,
  validateRoot: (root: Node, scopedConfig: Config) => TopikContentDiagnostic[],
): TopikContentDiagnostic[] {
  const partials = config.partials ?? {};
  const diagnostics: TopikContentDiagnostic[] = [];
  const visitingNames = new Set<string>();
  const visitingValues = new WeakSet<object>();
  const initialVariables = isPlainRecord(config.variables) ? config.variables : {};

  const visitReference = (reference: Node, variables: Record<string, unknown>): void => {
    const file = resolveCallbackFree(reference.attributes.file, variables);
    if (!file.ok || typeof file.value !== "string") {
      diagnostics.push(partialDiagnostic("topik-partial-invalid", reference));
      return;
    }
    const name = file.value;
    if (!Object.hasOwn(partials, name)) {
      diagnostics.push(partialDiagnostic("topik-partial-invalid", reference));
      return;
    }
    if (visitingNames.has(name)) {
      diagnostics.push(partialDiagnostic("topik-partial-cycle", reference));
      return;
    }

    const localVariables = resolvePartialVariables(reference.attributes.variables, variables);
    if (!localVariables.ok) {
      diagnostics.push(partialDiagnostic("topik-partial-invalid", reference));
      return;
    }
    const scopedVariables = {
      ...variables,
      ...localVariables.value,
      "$$partial:filename": name,
    };

    const value: unknown = partials[name];
    const roots = partialRoots(value);
    if (roots === undefined) {
      diagnostics.push(partialDiagnostic("topik-partial-invalid", reference));
      return;
    }
    const identity = value as object;
    if (visitingValues.has(identity)) {
      diagnostics.push(partialDiagnostic("topik-partial-cycle", reference));
      return;
    }

    visitingNames.add(name);
    visitingValues.add(identity);
    const graphState = partialNodeGraphState(roots);
    if (graphState !== "valid") {
      diagnostics.push(
        partialDiagnostic(
          graphState === "cycle" ? "topik-partial-cycle" : "topik-partial-invalid",
          reference,
        ),
      );
    } else {
      for (const partialRoot of roots) {
        const scopedConfig = { ...config, variables: scopedVariables };
        const nestedReferences = [partialRoot, ...partialRoot.walk()].filter(
          (node) => node.tag === "partial",
        );
        try {
          diagnostics.push(...validateRoot(partialRoot, scopedConfig));
          for (const node of nestedReferences) {
            visitReference(node, scopedVariables);
          }
        } catch {
          diagnostics.push(partialDiagnostic("topik-partial-invalid", reference));
        }
      }
    }
    visitingValues.delete(identity);
    visitingNames.delete(name);
  };

  for (const node of [root, ...root.walk()]) {
    if (node.tag === "partial") visitReference(node, initialVariables);
  }
  return uniqueDiagnostics(diagnostics);
}

type CallbackFreeResolution = { ok: true; value: unknown } | { ok: false };

function resolvePartialVariables(
  value: unknown,
  variables: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (value === undefined) return { ok: true, value: {} };
  const resolved = resolveCallbackFree(value, variables);
  return resolved.ok && isPlainRecord(resolved.value)
    ? { ok: true, value: resolved.value }
    : { ok: false };
}

function resolveCallbackFree(
  value: unknown,
  variables: Record<string, unknown>,
  visiting = new WeakSet<object>(),
): CallbackFreeResolution {
  if (Markdoc.Ast.isFunction(value) || value instanceof Markdoc.Ast.Node) return { ok: false };
  if (Markdoc.Ast.isVariable(value)) {
    let selected: unknown = variables;
    for (const key of value.path) {
      if (
        (typeof selected !== "object" && typeof selected !== "function") ||
        selected === null ||
        !Object.hasOwn(selected, key)
      ) {
        return { ok: false };
      }
      selected = (selected as Record<string | number, unknown>)[key];
    }
    return Markdoc.Ast.isAst(selected) ? { ok: false } : { ok: true, value: selected };
  }
  if (value === null || typeof value !== "object") return { ok: true, value };
  if (visiting.has(value)) return { ok: false };
  visiting.add(value);
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (const nested of value) {
      const item = resolveCallbackFree(nested, variables, visiting);
      if (!item.ok) return { ok: false };
      resolved.push(item.value);
    }
    visiting.delete(value);
    return { ok: true, value: resolved };
  }
  if (!isPlainRecord(value)) return { ok: false };
  const resolved: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const item = resolveCallbackFree(nested, variables, visiting);
    if (!item.ok) return { ok: false };
    resolved[key] = item.value;
  }
  visiting.delete(value);
  return { ok: true, value: resolved };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function partialRoots(value: unknown): Node[] | undefined {
  if (value instanceof Markdoc.Ast.Node) return [value];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry): entry is Node => entry instanceof Markdoc.Ast.Node)
    ? value
    : undefined;
}

function partialNodeGraphState(roots: Node[]): "valid" | "cycle" | "invalid" {
  const visiting = new WeakSet<Node>();
  const complete = new WeakSet<Node>();
  const visit = (node: Node): "valid" | "cycle" | "invalid" => {
    if (!(node instanceof Markdoc.Ast.Node)) return "invalid";
    if (visiting.has(node)) return "cycle";
    if (complete.has(node)) return "valid";
    if (
      typeof node.type !== "string" ||
      !Array.isArray(node.children) ||
      node.attributes === null ||
      typeof node.attributes !== "object" ||
      node.slots === null ||
      typeof node.slots !== "object"
    ) {
      return "invalid";
    }
    visiting.add(node);
    for (const nested of [...node.children, ...Object.values(node.slots)]) {
      const state = visit(nested);
      if (state !== "valid") return state;
    }
    visiting.delete(node);
    complete.add(node);
    return "valid";
  };

  for (const root of roots) {
    const state = visit(root);
    if (state !== "valid") return state;
  }
  return "valid";
}

function partialDiagnostic(
  id: "topik-partial-cycle" | "topik-partial-invalid",
  node: Node,
): TopikContentDiagnostic {
  return sanitizeTopikContentDiagnostic({
    id,
    type: node.type,
    level: "error",
    message: "",
    lines: node.lines,
    ...(node.location?.file === undefined ? {} : { file: node.location.file }),
  });
}

function validatePartialAssetReferences(
  root: Node,
  allowCompiledAssetReferences: boolean,
): TopikContentDiagnostic[] {
  const diagnostics: TopikContentDiagnostic[] = [];
  for (const node of [root, ...root.walk()]) {
    const slots =
      node.type === "image"
        ? (["src"] as const)
        : node.type === "tag" && node.tag === "figure"
          ? (["src", "darkSrc"] as const)
          : [];
    for (const attribute of slots) {
      const reference: unknown = node.attributes[attribute];
      if (typeof reference !== "string") continue;
      const validation = validateTopikAssetReference(reference);
      if (validation.valid && (validation.kind !== "asset" || allowCompiledAssetReferences)) {
        continue;
      }
      const compiledAsset = validation.valid && validation.kind === "asset";
      const external = !validation.valid && validation.failureKind === "external";
      diagnostics.push(
        sanitizeTopikContentDiagnostic({
          id: compiledAsset
            ? "TOPIK_ASSET_REFERENCE_MALFORMED"
            : external
              ? "TOPIK_EXTERNAL_REFERENCE_UNSAFE"
              : "TOPIK_ASSET_PATH_INVALID",
          type: `${node.tag ?? node.type}.${attribute}`,
          level: "error",
          message: "",
          lines: node.lines,
          ...(node.location?.file === undefined ? {} : { file: node.location.file }),
        }),
      );
    }
    if (node.type === "link") {
      const href: unknown = node.attributes.href;
      const linkErrors = validatePartialLinkReference(href, allowCompiledAssetReferences);
      for (const error of linkErrors) {
        diagnostics.push(
          sanitizeTopikContentDiagnostic({
            id: error.id,
            type: "link.href",
            level: error.level,
            message: error.message,
            lines: node.lines,
            ...(node.location?.file === undefined ? {} : { file: node.location.file }),
          }),
        );
      }
    }
  }
  return diagnostics;
}

function validatePartialLinkReference(
  href: unknown,
  allowCompiledAssetReferences: boolean,
): ReturnType<typeof validateTopikHref> {
  if (typeof href === "string") {
    if (href.startsWith("asset:")) {
      if (allowCompiledAssetReferences && validateTopikAssetReference(href).valid) return [];
      return [
        {
          id: "TOPIK_ASSET_REFERENCE_MALFORMED",
          level: "error",
          message: "",
        },
      ];
    }
    if (/^http:/iu.test(href)) {
      return [{ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", level: "error", message: "" }];
    }
  }
  return validateTopikHref(href);
}

/** Parsed HTTP(S) destinations remain policy-relevant when exact Markdown pairing is unavailable. */
function effectiveExternalReference(occurrence: TopikAssetOccurrence): string {
  return occurrence.reference.length === 0 && /^https?:/iu.test(occurrence.parsedReference)
    ? occurrence.parsedReference
    : occurrence.reference;
}
