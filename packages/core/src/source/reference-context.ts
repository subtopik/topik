import type { Wiki } from "@topik/schema/wiki/v1";
import { resolveWikiNavigation, type ResolvedWikiNavigation } from "../wiki-navigation";

/** Every saved body must have a source position in its own immutable Wiki snapshot. */
export function resolveSourceReferenceContext(
  context: Wiki,
  wikiName: string,
  pageName: string,
): { ok: true; navigation: ResolvedWikiNavigation } | { ok: false; message: string } {
  if (context.type !== "Wiki" || context.name !== wikiName)
    return { ok: false, message: "Saved reference context must belong to the same Wiki." };
  const navigation = resolveWikiNavigation(context.spec.navigation ?? [], {
    sourceVersion: context.spec.sourceVersion,
  });
  if (!navigation.pageByName.has(pageName))
    return { ok: false, message: "Saved reference context must contain the same page identity." };
  return { ok: true, navigation };
}
