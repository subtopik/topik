import { resolve } from "node:path";
import { compileWiki, resolveWikiNavigation, type AssetCompilationOptions } from "@topik/core";
import type { Wiki, WikiNavNode } from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { LoaderContext } from "astro/loaders";
import {
  compileTopikAssetLoader,
  requireTopikLoaderName,
  withTopikAssetSnapshot,
  type TopikAssetLoader,
} from "./assets";

export type { WikiNavNode };

export interface TopikWikiOptions {
  /** Path to the wiki directory (containing wiki.yaml). */
  dir: string;
  /** Stable loader identity shared across Astro module contexts; does not affect Asset names. */
  name: string;
  /** Name generator for local Assets. No manifest is required. */
  assets?: AssetCompilationOptions;
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
  const name = requireTopikLoaderName(options.name);
  const assets = options.assets;

  const compile = () => loadCompiledWiki(resolvedDir, assets);
  const enhanced = withTopikAssetSnapshot(
    {
      name,

      load: async (context: LoaderContext) => {
        context.logger.info(`Compiling wiki from ${resolvedDir}`);
        try {
          const compiled = await compileTopikAssetLoader(enhanced.loader);
          const pageResources = compiled.resources.filter(
            (resource): resource is WikiPage => resource.type === "WikiPage",
          );
          const navigation =
            compiled.resources.find((resource): resource is Wiki => resource.type === "Wiki")?.spec
              .navigation ?? [];
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
        const { navigation } = await loadCompiledWiki(resolvedDir, assets);
        return navigation;
      },
    },
    compile,
    { kind: "wiki", name, sourceRoot: resolvedDir },
  );
  return enhanced.loader;
}

async function loadCompiledWiki(
  dir: string,
  assets: AssetCompilationOptions | undefined,
): Promise<{
  navigation: WikiNavNode[];
  pageResources: WikiPage[];
  resources: Awaited<ReturnType<typeof compileWiki>>["resources"];
  payloads: Awaited<ReturnType<typeof compileWiki>>["payloads"];
  semantic: Awaited<ReturnType<typeof compileWiki>>["semantic"];
  materialization: Awaited<ReturnType<typeof compileWiki>>["materialization"];
}> {
  const { resources, payloads, semantic, materialization } = await compileWiki({
    dir,
    assets,
  });
  const wiki = resources.find((resource): resource is Wiki => resource.type === "Wiki");
  return {
    navigation: wiki?.spec.navigation ?? [],
    payloads,
    resources,
    semantic,
    materialization,
    pageResources: resources.filter(
      (resource): resource is WikiPage => resource.type === "WikiPage",
    ),
  };
}
