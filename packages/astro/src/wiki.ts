import { resolve } from "node:path";
import { compileWiki } from "@topik/core";
import type { Wiki, WikiPage, WikiNavNode } from "@topik/schema";

export type { WikiNavNode };

export interface TopikWikiOptions {
  /** Path to the wiki directory (containing wiki.yaml). */
  dir: string;
}

const WIKI_PAGE_TYPES = `
export type Entry = {
  wiki: string;
  title: string;
  slug: string;
};
`;

export function topikWikiLoader(options: TopikWikiOptions) {
  const resolvedDir = resolve(options.dir);

  let navigation: WikiNavNode[] = [];

  return {
    name: "topik-wiki",

    load: async (context: {
      store: {
        clear(): void;
        set(entry: {
          id: string;
          data: Record<string, unknown>;
          body?: string;
          digest?: string;
        }): void;
      };
      logger: { info(msg: string): void };
      generateDigest(data: string): string;
    }) => {
      context.logger.info(`Compiling wiki from ${resolvedDir}`);
      const { resources } = await compileWiki({ dir: resolvedDir });

      const wiki = resources.find((r): r is Wiki => r.type === "Wiki");
      navigation = wiki?.spec.navigation ?? [];

      const slugMap = buildSlugMap(navigation);

      context.store.clear();
      for (const resource of resources) {
        if (resource.type !== "WikiPage") continue;
        const page = resource as WikiPage;

        context.store.set({
          id: page.name,
          data: {
            wiki: page.spec.wiki,
            title: page.spec.title,
            slug: slugMap.get(page.name) ?? page.name,
          },
          body: page.spec.content.value,
          digest: context.generateDigest(page.spec.content.value),
        });
      }

      const pageCount = resources.filter((r) => r.type === "WikiPage").length;
      context.logger.info(`Loaded ${pageCount} wiki page(s)`);
    },

    createSchema: async () => {
      const { z } = await import("astro/zod");
      return {
        schema: z.object({
          wiki: z.string(),
          title: z.string(),
          slug: z.string(),
        }),
        types: WIKI_PAGE_TYPES,
      };
    },

    /** Access the compiled navigation tree after loading. */
    getNavigation: () => navigation,
  };
}

function buildSlugMap(nodes: WikiNavNode[]): Map<string, string> {
  const map = new Map<string, string>();
  function walk(nodes: WikiNavNode[]) {
    for (const node of nodes) {
      if (node.type === "page") {
        map.set(node.page, node.slug);
      } else if (node.type === "group" || node.type === "tab") {
        walk(node.children);
      }
    }
  }
  walk(nodes);
  return map;
}
