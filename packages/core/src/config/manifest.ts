import { z } from "zod";
import { validateProjectNamespace } from "../assets/asset";
import { validateTopikPath } from "../assets/path";

export const TOPIK_MANIFEST_FILENAME = ".topik.yaml";
export const TOPIK_MANIFEST_LIMITS = {
  maxBytes: 1_048_576,
  maxSources: 1_000,
  maxDepth: 32,
} as const;

export const topikManifestSourceSchema = z.strictObject({
  kind: z.enum(["wiki", "collection"]),
  config: z.string().refine(isConfigurationPath, "Expected a portable YAML/YML/JSON path"),
});

export const topikManifestSchema = z
  .strictObject({
    version: z.literal(1),
    namespace: z.string().transform((value, context) => {
      const result = validateProjectNamespace(value);
      if (result.ok) return result.value;
      context.addIssue({
        code: "custom",
        message: "Expected a nonempty portable project namespace",
      });
      return z.NEVER;
    }),
    sources: z.array(topikManifestSourceSchema).max(TOPIK_MANIFEST_LIMITS.maxSources),
  })
  .superRefine((manifest, context) => {
    const paths = manifest.sources.map((source) => source.config);
    const conflict = findConfigurationPathConflict(paths);
    if (conflict !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sources", conflict, "config"],
        message: "Configuration paths conflict",
      });
    }
  });

export type TopikManifest = z.infer<typeof topikManifestSchema>;
export type TopikManifestSource = z.infer<typeof topikManifestSourceSchema>;

export function parseTopikManifest(raw: unknown): TopikManifest {
  return topikManifestSchema.parse(raw);
}

export function isConfigurationPath(path: string): boolean {
  return /\.(?:yaml|yml|json)$/u.test(path) && validateTopikPath(path).ok;
}

/** Reject duplicate files and aliased components while permitting overlapping directories. */
function findConfigurationPathConflict(paths: readonly string[]): number | undefined {
  const spellings = new Map<string, string>();
  const files = new Set<string>();
  const directories = new Set<string>();
  for (let index = 0; index < paths.length; index++) {
    const components = paths[index].split("/");
    for (let count = 1; count <= components.length; count++) {
      const prefix = components.slice(0, count).join("/");
      const parsed = validateTopikPath(prefix);
      if (!parsed.ok) return index;
      const key = parsed.value.collisionKey;
      const previous = spellings.get(key);
      if ((previous !== undefined && previous !== prefix) || files.has(key)) return index;
      spellings.set(key, prefix);
      if (count === components.length) {
        if (directories.has(key)) return index;
        files.add(key);
      } else {
        directories.add(key);
      }
    }
  }
  return undefined;
}
