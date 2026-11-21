import { resolve } from "node:path";
import { compileWiki, resolveWikiNavigation, type AssetCompilationOptions } from "@topik/core";
import type { Wiki, WikiNavNode } from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { LoaderContext } from "astro/loaders";
import { loadTopikSource } from "./source-watch";
import {
  compileTopikAssetLoader,
  requireTopikLoaderName,
  withTopikAssetSnapshot,
  type TopikAssetLoader,
} from "./assets";

export type { WikiNavNode };

/**
 * Navigation of each loader's last published compilation, by loader name. Astro may run the
 * loader and the pages in different module contexts, so the registry lives on `globalThis`.
 */
const publishedNavigation: Map<string, WikiNavNode[]> = ((
  globalThis as { [key: symbol]: Map<string, WikiNavNode[]> | undefined }
)[Symbol.for("@topik/astro/wiki-navigation")] ??= new Map());

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
        await loadTopikSource(
          resolvedDir,
          context,
          enhanced.snapshot,
          () => compileTopikAssetLoader(enhanced.loader),
          (compiled) => {
            const pageResources = compiled.resources.filter(
              (resource): resource is WikiPage => resource.type === "WikiPage",
            );
            const wiki = compiled.resources.find(
              (resource): resource is Wiki => resource.type === "Wiki",
            );
            const navigation = wiki?.spec.navigation ?? [];
            const resolvedNavigation = resolveWikiNavigation(navigation);
            publishedNavigation.set(name, navigation);

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

            context.logger.info(`Loaded ${pageResources.length} wiki page(s)`);
          },
        );
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

      // The navigation of the entries in the store; compiled only before the first load.
      getNavigation: async () =>
        publishedNavigation.get(name) ?? (await loadCompiledWiki(resolvedDir, assets)).navigation,
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
  resources: Awaited<ReturnType<typeof compileWiki>>["resources"];
  payloads: Awaited<ReturnType<typeof compileWiki>>["payloads"];
  assetSourcePaths: Awaited<ReturnType<typeof compileWiki>>["assetSourcePaths"];
  semantic: Awaited<ReturnType<typeof compileWiki>>["semantic"];
  materialization: Awaited<ReturnType<typeof compileWiki>>["materialization"];
}> {
  const { resources, payloads, assetSourcePaths, semantic, materialization } = await compileWiki({
    dir,
    assets,
  });
  const wiki = resources.find((resource): resource is Wiki => resource.type === "Wiki");
  return {
    navigation: wiki?.spec.navigation ?? [],
    payloads,
    assetSourcePaths,
    resources,
    semantic,
    materialization,
  };
}
