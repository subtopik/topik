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
  // A drive letter is an absolute path on Windows, and `:` is not a portable filename character.
  if (/[\\[\]{}()!:]/.test(pattern)) return false;
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

/** Whether `name` matches one pattern segment, where `*` is any run and `?` one character. */
function matchesSegment(pattern: readonly string[], name: readonly string[]): boolean {
  // Greedy matching that returns to the last `*`: time is bounded by pattern × name length.
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p += 1;
      n += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = n;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      n = resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * A matcher for one pattern. It compares segment by segment and never builds a regular
 * expression, so no pattern text is read as expression syntax and matching cannot backtrack
 * without bound: time is bounded by pattern segments × path segments × their lengths.
 */
function patternMatcher(pattern: string): (path: string) => boolean {
  const segments = pattern
    .split("/")
    // Adjacent `**` segments mean the same as one.
    .filter((segment, index, all) => !(segment === "**" && all[index - 1] === "**"))
    .map((segment) => (segment === "**" ? undefined : Array.from(segment)));
  return (path) => {
    // By code point, so `?` takes one whole character.
    const names = path.split("/").map((name) => Array.from(name));
    const failed = new Set<number>();
    const matchesFrom = (s: number, n: number): boolean => {
      if (s === segments.length) return n === names.length;
      const key = s * (names.length + 1) + n;
      if (failed.has(key)) return false;
      const segment = segments[s];
      const matched =
        segment === undefined
          ? s === segments.length - 1
            ? // A trailing `**` takes everything below, and needs something to take.
              n < names.length
            : matchesFrom(s + 1, n) || (n < names.length && matchesFrom(s, n + 1))
          : n < names.length && matchesSegment(segment, names[n]!) && matchesFrom(s + 1, n + 1);
      if (!matched) failed.add(key);
      return matched;
    };
    return matchesFrom(0, 0);
  };
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
 * `README.md` in capitals is the file a repository host shows for a folder. Beside the
 * configuration a collection reads it as a guide only when its frontmatter sets both `id` and
 * `slug`; in a folder below, it is that folder's landing page.
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
  const include = includePatterns.map(patternMatcher);
  const exclude = (config.exclude ?? []).map(patternMatcher);
  return {
    nested: includePatterns.some((pattern) => pattern.includes("/") || pattern === "**"),
    matches(path) {
      const segments = path.split("/");
      const filename = segments.pop()!;
      return (
        /\.mdx?$/u.test(filename) &&
        // `README` can be a guide: compilation decides, beside the configuration by frontmatter.
        (isReadmeFilename(filename) || !isConventionMarkdownFilename(filename)) &&
        !segments.some(isSkippedCollectionDirectory) &&
        include.some((matches) => matches(path)) &&
        !exclude.some((matches) => matches(path))
      );
    },
  };
}
