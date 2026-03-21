import { resolve } from "node:path";
import { compileGuides } from "@topik/core";
import type { Guide } from "@topik/schema";

export interface TopikGuidesOptions {
  /** Path to the guide collection directory (containing collection.yaml). */
  dir: string;
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

export function topikGuidesLoader(options: TopikGuidesOptions) {
  const resolvedDir = resolve(options.dir);

  return {
    name: "topik-guides",

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
      context.logger.info(`Compiling guides from ${resolvedDir}`);
      const { resources } = await compileGuides({ dir: resolvedDir });

      context.store.clear();
      for (const resource of resources) {
        if (resource.type !== "Guide") continue;
        const guide = resource as Guide;

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

      context.logger.info(`Loaded ${resources.length} guide(s)`);
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
  };
}
