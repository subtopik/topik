import { resolve } from "node:path";
import { compileGuides, type AssetCompilationOptions } from "@topik/core";
import type { Guide } from "@topik/schema/guide/v1";
import type { LoaderContext } from "astro/loaders";
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
    });
  const enhanced = withTopikAssetSnapshot(
    {
      name,

      load: async (context: LoaderContext) => {
        context.logger.info(`Compiling guides from ${resolvedDir}`);
        try {
          const compiled = await compileTopikAssetLoader(enhanced.loader);
          const guides = compiled.resources.filter(
            (resource): resource is Guide => resource.type === "Guide",
          );

          context.store.clear();
          for (const guide of guides) {
            context.store.set({
              id: guide.name,
              data: {
                title: guide.spec.title,
                slug: guide.spec.slug,
                description: guide.spec.description,
                authors: guide.spec.authors ?? [],
                tags: guide.spec.tags ?? [],
              },
              body: guide.spec.content.value,
              digest: context.generateDigest(guide.spec.content.value),
            });
          }
          enhanced.snapshot.publish(compiled);

          context.logger.info(`Loaded ${guides.length} guide(s)`);
        } catch (error) {
          enhanced.snapshot.clear();
          throw error;
        }
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
