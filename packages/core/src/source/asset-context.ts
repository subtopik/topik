import { rewriteTopikAssetOccurrences } from "@topik/content";
import type { Resource } from "../resource";
import { failSourcePlan } from "./diagnostics";

export type SourceAssetReferenceContexts = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/** Retained saved Asset names resolve only through independently pinned identity mappings. */
export function applySourceAssetReferenceContexts(
  resources: Resource[],
  contexts: SourceAssetReferenceContexts | undefined,
  scope: readonly string[],
): void {
  for (const [key, mappings] of Object.entries(contexts ?? {})) {
    const resource = resources.find((resource) => `${resource.type}/${resource.name}` === key);
    if (
      !scope.includes(key) ||
      !resource ||
      (resource.type !== "Guide" && resource.type !== "WikiPage" && resource.type !== "CoursePage")
    )
      failSourcePlan(
        "resource-scope-denied",
        "Asset reference context exceeds the admitted document scope.",
        key,
      );
    for (const target of Object.values(mappings))
      if (!resources.some((resource) => resource.type === "Asset" && resource.name === target))
        failSourcePlan(
          "reference-context-invalid",
          "Asset reference context has no pinned target resource.",
          key,
        );
    const rewritten = rewriteTopikAssetOccurrences(
      resource.spec.content.value,
      (occurrence) => {
        if (!occurrence.reference.startsWith("asset:")) return undefined;
        const target = mappings[occurrence.reference.slice(6)];
        return target ? `asset:${target}` : undefined;
      },
      { allowCompiledAssetReferences: true, includeGenericLinkCandidates: true },
    );
    if (!rewritten.ok)
      failSourcePlan(
        "asset-reference-unrepresentable",
        "Saved Asset references cannot be transported faithfully.",
        key,
      );
    resource.spec.content.value = rewritten.content;
  }
}
