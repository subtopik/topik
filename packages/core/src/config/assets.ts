import { z } from "zod";
import { validateTopikPath } from "../assets/path";

export const DEFAULT_ASSET_DIRECTORY = "_assets";

/** Source-local destination for new synced media; not an input scan or compiler output path. */
export const sourceAssetsConfigSchema = z.strictObject({
  directory: z
    .string()
    .refine(
      (directory) => validateTopikPath(directory).ok,
      "Expected a portable relative directory",
    )
    .default(DEFAULT_ASSET_DIRECTORY),
});

export type SourceAssetsConfig = z.infer<typeof sourceAssetsConfigSchema>;
