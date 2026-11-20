import {
  mergeTopikContentConfig,
  type TopikContentConfig,
  type ResolvedTopikContentConfig,
} from "./config.js";
import { parseCachedDocumentTree, type TopikContentCache } from "./parse-cache.js";
import {
  locateDocumentAssetOccurrences,
  requiresAssetValidation,
  validateTopikAssetReference,
} from "./asset-references.js";
import { analyzeDocument, validateTopikHref, validateTopikNavigationHref } from "./links.js";
import { sanitizeTopikContentDiagnostic, type TopikContentDiagnostic } from "./diagnostics.js";
import { validateCustomAssetReferences } from "./custom-assets.js";
import type { ContentDocument, TreeNode } from "./model.js";
import { indexDocument, type DocumentIndex } from "./document-index.js";

export interface ValidateTopikContentOptions {
  file?: string;
  config?: TopikContentConfig;
  /** Accept compiler-produced references at a compiled-output boundary. */
  allowCompiledAssetReferences?: boolean;
  /** @internal Parse results shared with other calls given the same cache. */
  cache?: TopikContentCache;
}

export type PreparedSource =
  | { ok: false; source: string; diagnostics: TopikContentDiagnostic[] }
  | {
      ok: true;
      source: string;
      document: ContentDocument;
      config: ResolvedTopikContentConfig;
      index: DocumentIndex;
      diagnostics: TopikContentDiagnostic[];
    };

/**
 * A prepared document the caller may change: a tree shared through a cache is copied, with a
 * fresh index, so the change cannot reach another call's result.
 */
export function mutablePreparedDocument(prepared: Extract<PreparedSource, { ok: true }>): {
  document: ContentDocument;
  index: DocumentIndex;
} {
  if (!Object.isFrozen(prepared.document))
    return { document: prepared.document, index: prepared.index };
  const document = structuredClone(prepared.document);
  return { document, index: indexDocument(document) };
}

/**
 * A document the caller may change in place of the prepared one, and the node in it at the
 * position of each prepared node. A tree shared through a cache is copied; others are reused.
 */
export function mutablePreparedCopy(prepared: Extract<PreparedSource, { ok: true }>): {
  document: ContentDocument;
  nodeAt: (node: TreeNode) => TreeNode;
} {
  if (!Object.isFrozen(prepared.document))
    return { document: prepared.document, nodeAt: (node) => node };
  const document = structuredClone(prepared.document);
  const paths = new Map<TreeNode, readonly number[]>();
  for (const { node, path } of prepared.index.entries) paths.set(node, path);
  return {
    document,
    nodeAt: (node) => {
      const path = paths.get(node);
      if (path === undefined) throw new Error("Node is not part of the prepared document");
      return path.reduce<TreeNode>(
        (parent, index) => parent.children![index]!,
        document as TreeNode,
      );
    },
  };
}

/** `at` is the source start of the authored node that could not be written, when known. */
export function writeFailure(
  source: string,
  file?: string,
  at?: { line: number; column: number },
): Extract<PreparedSource, { ok: false }> {
  return {
    ok: false,
    source,
    diagnostics: [
      sanitizeTopikContentDiagnostic({
        id: "topik-write-failed",
        type: "document",
        level: "error",
        message: "",
        lines: at ? [at.line] : [],
        ...(at ? { column: at.column } : {}),
        ...(file === undefined ? {} : { file }),
      }),
    ],
  };
}

export function prepareSource(
  source: string,
  options: ValidateTopikContentOptions = {},
): PreparedSource {
  const errors: TopikContentDiagnostic[] = [];
  function add(
    id: string,
    type = "document",
    lines: number[] = [],
    option?: string,
    column?: number,
    detail: Pick<TopikContentDiagnostic, "tag" | "attribute" | "expected"> = {},
  ): void {
    errors.push(
      sanitizeTopikContentDiagnostic({
        id,
        type,
        level: [
          "topik-config-invalid",
          "tag-undefined",
          "node-undefined",
          "parse-error",
          "topik-extension-failed",
          // Tag syntax failures keep the severity they had as generic parse errors.
          "missing-closing",
          "missing-opening",
          "duplicate-attribute",
          "attribute-syntax-invalid",
          "tag-closing-invalid",
          "tag-name-invalid",
          "tag-placement-invalid",
          "tag-unterminated",
          "topik-else-placement",
          "topik-else-syntax",
        ].includes(id)
          ? "critical"
          : "error",
        message: "",
        lines,
        ...(option === undefined ? {} : { option }),
        ...(column === undefined ? {} : { column }),
        ...(detail.tag === undefined ? {} : { tag: detail.tag }),
        ...(detail.attribute === undefined ? {} : { attribute: detail.attribute }),
        ...(detail.expected === undefined ? {} : { expected: detail.expected }),
        ...(options.file === undefined ? {} : { file: options.file }),
      }),
    );
  }
  function failure(): PreparedSource {
    // One report per problem and line; the first occurrence keeps its column.
    const seen = new Set<string>();
    const unique = errors.filter((error) => {
      const key = JSON.stringify({ ...error, column: undefined });
      return !seen.has(key) && Boolean(seen.add(key));
    });
    return { ok: false, source, diagnostics: unique };
  }
  let config;
  try {
    config = mergeTopikContentConfig(options.config);
  } catch {
    add("topik-config-invalid");
    return failure();
  }

  try {
    const parsed = parseCachedDocumentTree(source, config.components, options.cache);
    for (const diagnostic of parsed.diagnostics)
      add(
        diagnostic.id ?? "parse-error",
        diagnostic.type,
        diagnostic.line ? [diagnostic.line] : [],
        diagnostic.option,
        diagnostic.column,
        diagnostic,
      );
    if (!parsed.document) return failure();

    const index = parsed.index ?? indexDocument(parsed.document);
    for (const issue of validateCustomAssetReferences(
      parsed.document,
      config.components,
      options.allowCompiledAssetReferences === true,
      index,
    ))
      add(issue.id, issue.type, issue.lines, undefined, issue.column);

    const analysis = analyzeDocument(parsed.document, options.file, index);
    errors.push(...analysis.diagnostics);
    for (const link of analysis.links) {
      const validate = link.kind === "card" ? validateTopikNavigationHref : validateTopikHref;
      for (const issue of validate(link.href))
        add(issue.id, link.kind, link.lines, undefined, link.column);
    }
    for (const { occurrence, node } of locateDocumentAssetOccurrences(
      parsed.document,
      source,
      {
        includeGenericLinkCandidates: true,
      },
      index,
    )) {
      if (!requiresAssetValidation(occurrence)) continue;
      const reference = occurrence.reference || occurrence.parsedReference;
      const validation = validateTopikAssetReference(reference);
      if (
        validation.valid &&
        occurrence.kind !== "unsafe" &&
        (validation.kind !== "asset" || options.allowCompiledAssetReferences)
      )
        continue;
      const reserved = occurrence.kind === "asset" || occurrence.kind === "reserved-asset";
      const external = validation.valid
        ? validation.kind === "external-https"
        : validation.failureKind === "external";
      add(
        reserved
          ? "TOPIK_ASSET_REFERENCE_MALFORMED"
          : external
            ? "TOPIK_EXTERNAL_REFERENCE_UNSAFE"
            : "TOPIK_ASSET_PATH_INVALID",
        occurrence.slot,
        node.position ? [node.position.start.line] : [],
        undefined,
        node.position?.start.column,
      );
    }
    if (errors.length === 0)
      return { ok: true, source, document: parsed.document, config, index, diagnostics: [] };
  } catch {
    add("topik-extension-failed");
  }
  return failure();
}
