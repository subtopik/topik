import type { Heading } from "mdast";
import GithubSlugger, { slug } from "github-slugger";
import type { ContentDocument } from "./model.js";
import { plainText, walkContent } from "./traversal.js";

/** Base anchor for headings whose text has no sluggable characters. */
const FALLBACK_HEADING_ID = "section";

export interface TopikHeading {
  id: string;
  level: number;
  title: string;
  /**
   * Present when the ID is generated from a title that other headings share. Such an ID is
   * numbered by occurrence (`details-1`), so adding or removing an earlier heading with the
   * same title moves it to another heading. Links should target an explicit ID instead.
   */
  positional?: true;
}

export function assignTopikHeadingIds(document: ContentDocument): TopikHeading[] {
  const headings: Heading[] = [];
  walkContent(document, (node) => {
    if (node.type === "heading") headings.push(node as unknown as Heading);
  });
  return assignHeadingIds(headings);
}

/** @internal Reuse headings collected by a bounded document index. */
export function assignHeadingIds(headings: readonly Heading[]): TopikHeading[] {
  const slugger = new GithubSlugger();
  const explicitIds = new Set<string>();
  for (const heading of headings) {
    if (typeof heading.data?.topikId === "string") explicitIds.add(heading.data.topikId);
  }
  const titles = headings.map((heading) => plainText(heading).trim().replace(/\s+/g, " "));
  // Generated IDs share a base when their titles slug alike, such as `C++` and `C#`.
  const bases = titles.map((title) => slug(title) || FALLBACK_HEADING_ID);
  const generatedBases = new Map<string, number>();
  headings.forEach((heading, index) => {
    if (typeof heading.data?.topikId !== "string")
      generatedBases.set(bases[index], (generatedBases.get(bases[index]) ?? 0) + 1);
  });
  return headings.map((heading, index) => {
    const title = titles[index];
    const explicit = heading.data?.topikId;
    let id = explicit;
    if (typeof id !== "string") {
      // Explicit anchors retain their spelling; only generated IDs are slugified.
      // Headings without sluggable text share a fallback so no ID is ever empty.
      const base = slug(title) === "" ? FALLBACK_HEADING_ID : title;
      do {
        id = slugger.slug(base);
      } while (explicitIds.has(id));
    }
    heading.data = { ...heading.data, hProperties: { id } };
    return {
      id,
      level: heading.depth,
      title,
      ...(typeof explicit !== "string" && generatedBases.get(bases[index])! > 1
        ? { positional: true as const }
        : {}),
    };
  });
}
