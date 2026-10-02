import type { ContentDocument } from "./model.js";
import { components, getEffectiveProps, type Registry } from "./registry.js";
import { validateTopikAssetReference } from "./asset-reference-policy.js";
import { indexDocument, type DocumentIndex } from "./document-index.js";

interface AssetIssue {
  id: string;
  type: string;
  lines: number[];
}

/** Custom assets share URL admission, but do not extend the compiler's closed slot protocol. */
export function validateCustomAssetReferences(
  document: ContentDocument,
  registry: Registry,
  allowCompiled: boolean,
  index: DocumentIndex = indexDocument(document),
): AssetIssue[] {
  const issues: AssetIssue[] = [];
  for (const { node } of index.entries) {
    if (node.type !== "topikComponent" || !node.name || Object.hasOwn(components, node.name))
      continue;
    const definition = Object.hasOwn(registry, node.name) ? registry[node.name] : undefined;
    if (!definition) continue;
    const props = getEffectiveProps({ name: node.name, props: node.props ?? {} }, registry);
    for (const [name, attribute] of Object.entries(definition.attributes)) {
      if (!attribute.asset && !attribute.assetReference) continue;
      const reference = props[name];
      // Shape validation reports invalid types; optional absent properties have no URL.
      if (typeof reference !== "string") continue;
      const result = validateTopikAssetReference(reference);
      if (result.valid && (result.kind !== "asset" || allowCompiled)) continue;
      issues.push({
        id: /^asset:/iu.test(reference)
          ? "TOPIK_ASSET_REFERENCE_MALFORMED"
          : !result.valid && result.failureKind === "external"
            ? "TOPIK_EXTERNAL_REFERENCE_UNSAFE"
            : "TOPIK_ASSET_PATH_INVALID",
        type: `${node.name}.${name}`,
        lines: node.position ? [node.position.start.line] : [],
      });
    }
  }
  return issues;
}
