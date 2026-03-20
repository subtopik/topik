import { z } from "zod";

const nameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const collectionConfigSchema = z.object({
  id: z.string().min(1).max(63).regex(nameRegex),
  title: z.string().min(1).max(256),
  tags: z.array(z.string().min(1).max(63)).optional(),
});

export type CollectionConfig = z.infer<typeof collectionConfigSchema>;

export function parseCollectionConfig(raw: unknown): CollectionConfig {
  return collectionConfigSchema.parse(raw);
}
