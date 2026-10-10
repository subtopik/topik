import { z } from "zod";
import { DEFAULT_ASSET_DIRECTORY, sourceAssetsConfigSchema } from "./assets";
import { sourceVersionSchema, parseSourcePersons } from "./source-version";

const nameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const collectionConfigSchema = z.object({
  id: z.string().min(1).max(63).regex(nameRegex),
  title: z.string().min(1).max(256),
  sourceVersion: sourceVersionSchema,
  persons: z.unknown().optional(),
  assets: sourceAssetsConfigSchema.default({ directory: DEFAULT_ASSET_DIRECTORY }),
  tags: z.array(z.string().min(1).max(63)).optional(),
});

export type CollectionConfig = Omit<z.infer<typeof collectionConfigSchema>, "persons"> & {
  persons?: ReturnType<typeof parseSourcePersons>;
};

export function parseCollectionConfig(raw: unknown): CollectionConfig {
  const { persons, ...config } = collectionConfigSchema.parse(raw);
  return {
    ...config,
    ...(config.sourceVersion === 1 && persons !== undefined
      ? { persons: parseSourcePersons(persons) }
      : {}),
  };
}
