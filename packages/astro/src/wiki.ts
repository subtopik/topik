import { resolve } from "node:path";
import { compileWiki } from "@topik/core";
import type { Wiki, WikiPage, WikiNavNode } from "@topik/schema";
import type { Loader, LoaderContext } from "astro/loaders";

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

export function topikWikiLoader(options: TopikWikiOptions): Loader & {
  getNavigation(): Promise<WikiNavNode[]>;
} {
  const resolvedDir = resolve(options.dir);

  return {
    name: "topik-wiki",

    load: async (context: LoaderContext) => {
      context.logger.info(`Compiling wiki from ${resolvedDir}`);
      const { pageResources, navigation } = await loadCompiledWiki(resolvedDir);
      const slugMap = buildSlugMap(navigation);

      context.store.clear();
      for (const page of pageResources) {
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

      context.logger.info(`Loaded ${pageResources.length} wiki page(s)`);
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

    getNavigation: async () => {
      const { navigation } = await loadCompiledWiki(resolvedDir);
      return navigation;
    },
  };
}

async function loadCompiledWiki(dir: string): Promise<{
  navigation: WikiNavNode[];
  pageResources: WikiPage[];
}> {
  const { resources } = await compileWiki({ dir });
  const wiki = resources.find((resource): resource is Wiki => resource.type === "Wiki");
  return {
    navigation: wiki?.spec.navigation ?? [],
    pageResources: resources.filter(
      (resource): resource is WikiPage => resource.type === "WikiPage",
    ),
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
