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
 * Navigation of each loader's last published compilation, by source directory and loader name.
 * Astro may run the loader and the pages in different module contexts, so the registry lives on
 * `globalThis`.
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
  const navigationKey = JSON.stringify([resolvedDir, name]);

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
            publishedNavigation.set(navigationKey, navigation);

            context.store.clear();
            for (const page of pageResources) {
              const data = {
                wiki: page.spec.wiki,
                title: page.spec.title,
                slug: resolvedNavigation.pageByName.get(page.name)?.route ?? page.name,
                description: page.spec.description ?? undefined,
              };
              const body = page.spec.content.value;
              context.store.set({
                id: page.name,
                data,
                body,
                digest: context.generateDigest(JSON.stringify({ data, body })),
              });
            }

            context.logger.info(`Loaded ${pageResources.length} wiki page(s)`);
          },
          () => {
            publishedNavigation.delete(navigationKey);
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

      // The last published navigation; compiled on demand before the first load or after a failed
      // reload clears it.
      getNavigation: async () =>
        publishedNavigation.get(navigationKey) ??
        (await loadCompiledWiki(resolvedDir, assets)).navigation,
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
