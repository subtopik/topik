import { resolve } from "node:path";
import { compileWiki } from "@topik/core";
import { resolveWikiNavigation, type Wiki, type WikiPage, type WikiNavNode } from "@topik/schema";
import type { LoaderContext } from "astro/loaders";
import {
  requireTopikSourceNamespace,
  withTopikAssetSnapshot,
  type TopikAssetLoader,
} from "./assets";

export type { WikiNavNode };

export interface TopikWikiOptions {
  /** Path to the wiki directory (containing wiki.yaml). */
  dir: string;
  /** Stable, versioned identity namespace for automatically discovered Assets. */
  sourceNamespace: string;
}

const WIKI_PAGE_TYPES = `
export type Entry = {
  wiki: string;
  title: string;
  slug: string;
  description?: string;
};
`;

export function topikWikiLoader(options: TopikWikiOptions): TopikAssetLoader & {
  getNavigation(): Promise<WikiNavNode[]>;
} {
  const resolvedDir = resolve(options.dir);
  const sourceNamespace = requireTopikSourceNamespace(options.sourceNamespace);

  const enhanced = withTopikAssetSnapshot({
    name: "topik-wiki",

    load: async (context: LoaderContext) => {
      context.logger.info(`Compiling wiki from ${resolvedDir}`);
      try {
        const compiled = await loadCompiledWiki(resolvedDir, sourceNamespace);
        const { pageResources, navigation } = compiled;
        const resolvedNavigation = resolveWikiNavigation(navigation);

        context.store.clear();
        for (const page of pageResources) {
          context.store.set({
            id: page.name,
            data: {
              wiki: page.spec.wiki,
              title: page.spec.title,
              slug: resolvedNavigation.pageByName.get(page.name)?.route ?? page.name,
              description: page.spec.description ?? undefined,
            },
            body: page.spec.content.value,
            digest: context.generateDigest(page.spec.content.value),
          });
        }
        enhanced.snapshot.publish(compiled);

        context.logger.info(`Loaded ${pageResources.length} wiki page(s)`);
      } catch (error) {
        enhanced.snapshot.clear();
        throw error;
      }
    },

    createSchema: async () => {
      const { z } = await import("astro/zod");
      return {
        schema: z.object({
          wiki: z.string(),
          title: z.string(),
          slug: z.string(),
          description: z.string().optional(),
        }),
        types: WIKI_PAGE_TYPES,
      };
    },

    getNavigation: async () => {
      const { navigation } = await loadCompiledWiki(resolvedDir, sourceNamespace);
      return navigation;
    },
  });
  return enhanced.loader;
}

async function loadCompiledWiki(
  dir: string,
  sourceNamespace: string,
): Promise<{
  navigation: WikiNavNode[];
  pageResources: WikiPage[];
  resources: Awaited<ReturnType<typeof compileWiki>>["resources"];
  payloads: Awaited<ReturnType<typeof compileWiki>>["payloads"];
}> {
  const { resources, payloads } = await compileWiki({
    dir,
    assets: { sourceNamespace },
  });
  const wiki = resources.find((resource): resource is Wiki => resource.type === "Wiki");
  return {
    navigation: wiki?.spec.navigation ?? [],
    payloads,
    resources,
    pageResources: resources.filter(
      (resource): resource is WikiPage => resource.type === "WikiPage",
    ),
  };
}
