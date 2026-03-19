import { z } from "zod";

const nameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const collectionSchema = z.object({
  name: z.string().min(1).max(63).regex(nameRegex),
  path: z.string().min(1).default("."),
  format: z.enum(["topik"]).default("topik"),
  tags: z.array(z.string().min(1).max(63)).optional(),
});

const topikConfigSchema = z.object({
  collections: z.array(collectionSchema).min(1),
});

export type Collection = z.infer<typeof collectionSchema>;
export type TopikConfig = z.infer<typeof topikConfigSchema>;

export function parseTopikConfig(raw: unknown): TopikConfig {
  return topikConfigSchema.parse(raw);
}
