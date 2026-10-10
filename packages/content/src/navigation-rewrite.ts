import { indexDocument, isReference } from "./document-index.js";
import { prepareSource, writeFailure } from "./source.js";
import { writeDocument } from "./writer.js";
import { sameDocumentMeaning } from "./document-meaning.js";
import type { TreeNode } from "./model.js";
import type { ValidateTopikContentOptions } from "./validate.js";
import type { TopikContentDiagnostic } from "./diagnostics.js";

export interface TopikNavigationReference {
  href: string;
  kind: "link" | "card";
  position: string;
}
export type RewriteTopikNavigationResult =
  | {
      ok: true;
      content: string;
      changes: readonly (TopikNavigationReference & { replacement: string })[];
      diagnostics: TopikContentDiagnostic[];
    }
  | { ok: false; source: string; diagnostics: TopikContentDiagnostic[] };

/** Rewrite actual navigation references, retaining definitions/scopes and every authored branch. */
export function rewriteTopikNavigationReferences(
  source: string,
  replace: (reference: TopikNavigationReference) => string | undefined,
  options: ValidateTopikContentOptions = {},
): RewriteTopikNavigationResult {
  const prepared = prepareSource(source, options);
  if (!prepared.ok) return prepared;
  const index = indexDocument(prepared.document);
  const changes: Array<TopikNavigationReference & { replacement: string }> = [];
  const targets = new Map<TreeNode, string>();
  const imageDefinitions = new Set<TreeNode>();
  for (const { node } of index.entries) {
    if (node.type !== "imageReference" || !isReference(node)) continue;
    const definition = index.resolve(node);
    if (definition) imageDefinitions.add(definition);
  }
  for (const { node, path } of index.entries) {
    const kind =
      node.type === "link" || node.type === "linkReference"
        ? "link"
        : node.type === "topikComponent" && node.name === "card"
          ? "card"
          : undefined;
    if (!kind) continue;
    const target = isReference(node) ? index.resolve(node) : node;
    if (!target) return writeFailure(source, options.file);
    const href = kind === "card" ? node.props?.href : (target as TreeNode & { url?: string }).url;
    if (typeof href !== "string") continue;
    const reference: TopikNavigationReference = { href, kind, position: path.join("/") };
    const replacement = replace(reference) ?? href;
    const prior = targets.get(target);
    if (
      (prior !== undefined && prior !== replacement) ||
      (replacement !== href && imageDefinitions.has(target))
    )
      return writeFailure(source, options.file);
    targets.set(target, replacement);
    if (replacement !== href) changes.push({ ...reference, replacement });
  }
  if (!changes.length) return { ok: true, content: source, changes, diagnostics: [] };
  for (const [node, replacement] of targets) {
    if (node.type === "topikComponent") node.props!.href = replacement;
    else (node as TreeNode & { url: string }).url = replacement;
  }
  let content: string;
  try {
    content = writeDocument(prepared.document, prepared.config.components);
  } catch {
    return writeFailure(source, options.file);
  }
  const output = prepareSource(content, { ...options, config: prepared.config });
  if (!output.ok || !sameDocumentMeaning(prepared.document, output.document))
    return writeFailure(source, options.file);
  return { ok: true, content, changes, diagnostics: [] };
}
