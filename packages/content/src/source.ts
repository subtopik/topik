import {
  mergeTopikContentConfig,
  type TopikContentConfig,
  type ResolvedTopikContentConfig,
} from "./config.js";
import { parseDocumentTree } from "./parser.js";
import {
  locateDocumentAssetOccurrences,
  requiresAssetValidation,
  validateTopikAssetReference,
} from "./asset-references.js";
import { analyzeDocument, validateTopikHref, validateTopikNavigationHref } from "./links.js";
import { sanitizeTopikContentDiagnostic, type TopikContentDiagnostic } from "./diagnostics.js";
import { validateCustomAssetReferences } from "./custom-assets.js";
import type { ContentDocument } from "./model.js";
import { indexDocument, type DocumentIndex } from "./document-index.js";

export interface ValidateTopikContentOptions {
  file?: string;
  config?: TopikContentConfig;
  /** Accept compiler-produced references at a compiled-output boundary. */
  allowCompiledAssetReferences?: boolean;
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

export function writeFailure(
  source: string,
  file?: string,
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
        lines: [],
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
  function add(id: string, type = "document", lines: number[] = []): void {
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
        ].includes(id)
          ? "critical"
          : "error",
        message: "",
        lines,
        ...(options.file === undefined ? {} : { file: options.file }),
      }),
    );
  }
  function failure(): PreparedSource {
    const unique = [...new Map(errors.map((error) => [JSON.stringify(error), error])).values()];
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
    const parsed = parseDocumentTree(source, config.components);
    for (const diagnostic of parsed.diagnostics)
      add(
        diagnostic.id ?? "parse-error",
        diagnostic.type,
        diagnostic.line ? [diagnostic.line] : [],
      );
    if (!parsed.document) return failure();

    const index = parsed.index ?? indexDocument(parsed.document);
    for (const issue of validateCustomAssetReferences(
      parsed.document,
      config.components,
      options.allowCompiledAssetReferences === true,
      index,
    ))
      add(issue.id, issue.type, issue.lines);

    const analysis = analyzeDocument(parsed.document, options.file, index);
    errors.push(...analysis.diagnostics);
    for (const link of analysis.links) {
      const validate = link.kind === "card" ? validateTopikNavigationHref : validateTopikHref;
      for (const issue of validate(link.href)) add(issue.id, link.kind, link.lines);
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
      );
    }
    if (errors.length === 0)
      return { ok: true, source, document: parsed.document, config, index, diagnostics: [] };
  } catch {
    add("topik-extension-failed");
  }
  return failure();
}
