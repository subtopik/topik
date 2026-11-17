import { z } from "zod";
import { DEFAULT_ASSET_DIRECTORY, sourceAssetsConfigSchema } from "./assets";
import { rejectMisspelledKeys } from "./misspelled-keys";
import { sourceVersionSchema, parseSourcePersons } from "./source-version";

const nameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The Markdown files directly beside the configuration. */
export const DEFAULT_COLLECTION_INCLUDE: readonly string[] = ["*.md", "*.mdx"];

/**
 * A pattern is a path relative to the configuration directory with `/` separators. `*` and `?`
 * match within one path segment, and a `**` segment matches any number of directories.
 */
const patternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isCollectionPattern, "Patterns are relative paths that use only *, ? and ** wildcards");

function isCollectionPattern(pattern: string): boolean {
  if (/[\\[\]{}()!]/.test(pattern)) return false;
  return pattern
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        (segment === "**" || !segment.includes("**")),
    );
}

const collectionConfigSchema = z.object({
  id: z.string().min(1).max(63).regex(nameRegex),
  title: z.string().min(1).max(256),
  sourceVersion: sourceVersionSchema,
  persons: z.unknown().optional(),
  assets: sourceAssetsConfigSchema.default({ directory: DEFAULT_ASSET_DIRECTORY }),
  tags: z.array(z.string().min(1).max(63)).optional(),
  include: z.array(patternSchema).min(1).max(64).optional(),
  exclude: z.array(patternSchema).max(64).optional(),
});

export type CollectionConfig = Omit<z.infer<typeof collectionConfigSchema>, "persons"> & {
  persons?: ReturnType<typeof parseSourcePersons>;
};

export function parseCollectionConfig(raw: unknown): CollectionConfig {
  rejectMisspelledKeys(raw, Object.keys(collectionConfigSchema.shape));
  const { persons, ...config } = collectionConfigSchema.parse(raw);
  return {
    ...config,
    ...(config.sourceVersion === 1 && persons !== undefined
      ? { persons: parseSourcePersons(persons) }
      : {}),
  };
}

function patternExpression(pattern: string): RegExp {
  const segments = pattern.split("/");
  let source = "^";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // A trailing `**` takes everything below; elsewhere it takes zero or more directories.
      source += last ? ".+" : "(?:[^/]+/)*";
      return;
    }
    source += segment
      .replace(/[.+^$|]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    if (!last) source += "/";
  });
  return new RegExp(`${source}$`, "u");
}

/**
 * Markdown named by repository convention in capitals, such as `README.md`, `AGENTS.md` or
 * `CHANGELOG.md`, is not Topik content: the name has an uppercase letter and no lowercase one
 * before the extension. A filename-derived guide name is lowercase, so no guide is lost.
 */
export function isConventionMarkdownFilename(filename: string): boolean {
  const stem = filename.replace(/\.[^.]*$/u, "");
  return /[A-Z]/.test(stem) && !/[a-z]/.test(stem);
}

/**
 * `README.md` in capitals is the file a repository host shows for a folder. A collection reads
 * it as a guide only when its frontmatter sets both `id` and `slug`.
 */
export function isReadmeFilename(filename: string): boolean {
  return /^README\.mdx?$/u.test(filename);
}

/** Directories no collection reads: dependencies and dot-directories such as `.topik`. */
export function isSkippedCollectionDirectory(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

export interface CollectionGuideFilter {
  /** Whether `include` can match a file below the configuration directory. */
  readonly nested: boolean;
  /** Whether a path relative to the configuration directory, with `/`, is a guide file. */
  matches(path: string): boolean;
}

/**
 * The one rule for which files are guides of a collection, shared by compilation and source
 * writing: a `.md` or `.mdx` file that `include` matches and `exclude` does not, outside
 * skipped directories, whose name is not a convention file. `README` matches; compilation
 * then leaves it out unless its frontmatter names a guide.
 */
export function collectionGuideFilter(config: {
  include?: readonly string[];
  exclude?: readonly string[];
}): CollectionGuideFilter {
  const includePatterns = config.include ?? DEFAULT_COLLECTION_INCLUDE;
  const include = includePatterns.map(patternExpression);
  const exclude = (config.exclude ?? []).map(patternExpression);
  return {
    nested: includePatterns.some((pattern) => pattern.includes("/")),
    matches(path) {
      const segments = path.split("/");
      const filename = segments.pop()!;
      return (
        /\.mdx?$/u.test(filename) &&
        // `README` can be a guide: compilation reads its frontmatter to decide.
        (isReadmeFilename(filename) || !isConventionMarkdownFilename(filename)) &&
        !segments.some(isSkippedCollectionDirectory) &&
        include.some((pattern) => pattern.test(path)) &&
        !exclude.some((pattern) => pattern.test(path))
      );
    },
  };
}
