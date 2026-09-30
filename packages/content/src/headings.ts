import type { Heading } from "mdast";
import GithubSlugger from "github-slugger";
import type { ContentDocument } from "./model.js";
import { plainText, walkContent } from "./traversal.js";

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
      do {
        id = slugger.slug(title);
      } while (explicitIds.has(id));
    }
    heading.data = { ...heading.data, hProperties: { id } };
    return { id, level: heading.depth, title };
  });
}
