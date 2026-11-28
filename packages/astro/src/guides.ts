import { resolve } from "node:path";
import { compileGuides, type AssetCompilationOptions } from "@topik/core";
import type { Guide } from "@topik/schema/guide/v1";
import type { Person } from "@topik/schema/person/v1";
import type { LoaderContext } from "astro/loaders";
import { loadTopikSource } from "./source-watch";
import {
  compileTopikAssetLoader,
  requireTopikLoaderName,
  withTopikAssetSnapshot,
  type TopikAssetLoader,
} from "./assets";

export interface TopikGuidesOptions {
  /** Path to the guide collection directory (containing collection.yaml). */
  dir: string;
  /** Stable loader identity shared across Astro module contexts; does not affect Asset names. */
  name: string;
  /** Name generator for local Assets. No manifest is required. */
  assets?: AssetCompilationOptions;
  /** Persons the guides' authors refer to; a project declares them in its `.topik.yaml`. */
  persons?: readonly Person[];
}

const GUIDE_TYPES = `
export type Entry = {
  title: string;
  slug: string;
  description?: string;
  authors: string[];
  tags: string[];
};
`;

export function topikGuidesLoader(options: TopikGuidesOptions): TopikAssetLoader {
  const resolvedDir = resolve(options.dir);
  const name = requireTopikLoaderName(options.name);
  const assets = options.assets;

  const compile = () =>
    compileGuides({
      dir: resolvedDir,
      assets,
      persons: options.persons,
    });
  const enhanced = withTopikAssetSnapshot(
    {
      name,

      load: async (context: LoaderContext) => {
        context.logger.info(`Compiling guides from ${resolvedDir}`);
        await loadTopikSource(
          resolvedDir,
          context,
          enhanced.snapshot,
          () => compileTopikAssetLoader(enhanced.loader),
          (compiled) => {
            const guides = compiled.resources.filter(
              (resource): resource is Guide => resource.type === "Guide",
            );

            context.store.clear();
            for (const guide of guides) {
              const data = {
                title: guide.spec.title,
                slug: guide.spec.slug,
                description: guide.spec.description ?? undefined,
                authors: guide.spec.authors ?? [],
                tags: guide.spec.tags ?? [],
              };
              const body = guide.spec.content.value;
              context.store.set({
                id: guide.name,
                data,
                body,
                digest: context.generateDigest(JSON.stringify({ data, body })),
              });
            }

            context.logger.info(`Loaded ${guides.length} guide(s)`);
          },
        );
      },

      createSchema: async () => {
        const { z } = await import("astro/zod");
        return {
          schema: z.object({
            title: z.string(),
            slug: z.string(),
            description: z.string().optional(),
            authors: z.array(z.string()).default([]),
            tags: z.array(z.string()).default([]),
          }),
          types: GUIDE_TYPES,
        };
      },
    },
    compile,
    { kind: "guides", name, sourceRoot: resolvedDir },
  );
  return enhanced.loader;
}
