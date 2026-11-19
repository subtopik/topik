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
  const assigned = headingIds(headings);
  for (const [index, heading] of headings.entries())
    heading.data = { ...heading.data, hProperties: { id: assigned[index]!.id } };
  return assigned;
}

/** @internal The IDs {@link assignHeadingIds} gives, without writing them into the tree. */
export function headingIds(headings: readonly Heading[]): TopikHeading[] {
  const slugger = new GithubSlugger();
  const explicitIds = new Set<string>();
  for (const heading of headings) {
    if (typeof heading.data?.topikId === "string") explicitIds.add(heading.data.topikId);
  }
  return headings.map((heading) => {
    const title = plainText(heading).trim().replace(/\s+/g, " ");
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
    return { id, level: heading.depth, title };
  });
}
