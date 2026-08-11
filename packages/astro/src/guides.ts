import { resolve } from "node:path";
import { compileGuides } from "@topik/core";
import type { Guide } from "@topik/schema";
import type { LoaderContext } from "astro/loaders";
import {
  requireTopikSourceNamespace,
  withTopikAssetSnapshot,
  type TopikAssetLoader,
} from "./assets";

export interface TopikGuidesOptions {
  /** Path to the guide collection directory (containing collection.yaml). */
  dir: string;
  /** Stable, versioned identity namespace for automatically discovered Assets. */
  sourceNamespace: string;
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
  const sourceNamespace = requireTopikSourceNamespace(options.sourceNamespace);

  const enhanced = withTopikAssetSnapshot({
    name: "topik-guides",

    load: async (context: LoaderContext) => {
      context.logger.info(`Compiling guides from ${resolvedDir}`);
      try {
        const compiled = await compileGuides({
          dir: resolvedDir,
          assets: { sourceNamespace },
        });
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
  });
  return enhanced.loader;
}
