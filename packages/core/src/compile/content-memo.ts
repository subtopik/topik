import {
  analyzeTopikContent,
  createTopikContentCache,
  pruneTopikContentCache,
  rewriteTopikNavigationReferences,
  validateTopikContent,
  type RewriteTopikNavigationResult,
  type TopikContentCache,
  type TopikNavigationReference,
  type AnalyzeTopikContentResult,
  type ValidateTopikContentResult,
} from "@topik/content";

/**
 * @internal Source admission and analysis remembered across compiler calls. Results are keyed
 * by the exact source text and diagnostic file label, the only inputs the compiler passes, so a
 * repeated call returns what a fresh call would. Results are frozen: they are shared by every
 * call that reads the same text.
 *
 * A compilation creates its own memo unless it is given one. A caller that keeps a memo across
 * compilations, such as a watcher, calls {@link ContentMemo.prune} after each, so the memo holds
 * at most what the last two compilations read.
 */
export interface ContentMemo {
  /** Parsed documents shared by every content call of this compilation; pass it to each. */
  readonly cache: TopikContentCache;
  validate(source: string, file: string): ValidateTopikContentResult;
  analyze(source: string, file: string): AnalyzeTopikContentResult;
  /**
   * Rewrites the navigation references of `source` whose key `keyOf` finds in `replacements`,
   * and returns the result with the references it replaced, in document order.
   */
  rewriteNavigation(
    source: string,
    options: { file: string; allowCompiledAssetReferences?: boolean },
    replacements: ReadonlyMap<string, string>,
    keyOf: (reference: TopikNavigationReference) => string,
  ): NavigationRewrite;
  /** Drops what no call read since the previous prune. */
  prune(): void;
}

export interface NavigationRewrite {
  result: RewriteTopikNavigationResult;
  replaced: readonly TopikNavigationReference[];
}

/** Results read since the last prune, and before it, by source text and then file label. */
class Generations<T> {
  private current = new Map<string, Map<string, T>>();
  private previous = new Map<string, Map<string, T>>();

  get(source: string, file: string, compute: () => T): T {
    let result = this.current.get(source)?.get(file) ?? this.previous.get(source)?.get(file);
    result ??= deepFreeze(compute());
    let byFile = this.current.get(source);
    if (byFile === undefined) this.current.set(source, (byFile = new Map()));
    byFile.set(file, result);
    return result;
  }

  prune(): void {
    this.previous = this.current;
    this.current = new Map();
  }
}

function deepFreeze<T>(root: T): T {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const key of Object.keys(value)) stack.push((value as Record<string, unknown>)[key]);
  }
  return root;
}

export function createContentMemo(): ContentMemo {
  const validations = new Generations<ValidateTopikContentResult>();
  const analyses = new Generations<AnalyzeTopikContentResult>();
  const navigationRewrites = new Generations<NavigationRewrite>();
  const cache = createTopikContentCache();
  return {
    cache,
    validate: (source, file) =>
      validations.get(source, file, () => validateTopikContent(source, { file, cache })),
    analyze: (source, file) =>
      analyses.get(source, file, () => analyzeTopikContent(source, { file, cache })),
    rewriteNavigation(source, options, replacements, keyOf) {
      // `keyOf` is a fixed function of a reference, so the mapping decides every replacement.
      const key = JSON.stringify([
        options.file,
        options.allowCompiledAssetReferences === true,
        [...replacements].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ]);
      return navigationRewrites.get(source, key, () => {
        const replaced: TopikNavigationReference[] = [];
        const result = rewriteTopikNavigationReferences(
          source,
          (reference) => {
            const replacement = replacements.get(keyOf(reference));
            if (replacement !== undefined) replaced.push(reference);
            return replacement;
          },
          { ...options, cache },
        );
        return { result, replaced };
      });
    },
    prune() {
      validations.prune();
      analyses.prune();
      navigationRewrites.prune();
      pruneTopikContentCache(cache);
    },
  };
}
