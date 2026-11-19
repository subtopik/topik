import { components, type Registry } from "./registry.js";
import { parseDocumentTree, type DocumentTreeResult } from "./parser.js";
import { markVerifiedData } from "./limits.js";

declare const cacheBrand: unique symbol;

/**
 * @internal Parsed documents shared by the content calls that are given the same cache, so
 * validating, analyzing and rewriting one source parses it once. Owned by its caller: create
 * one for a batch of related calls, such as one compilation, and drop it afterwards.
 *
 * Entries are keyed by the exact source text. Only documents parsed with the built-in
 * components are shared; a call with custom components parses afresh. Shared trees are deeply
 * frozen: a call that would modify one fails instead of changing another call's result.
 */
export interface TopikContentCache {
  readonly [cacheBrand]: true;
}

/** Documents parsed with the built-in components, by source text: read since the last prune, and before. */
interface CacheState {
  current: Map<string, DocumentTreeResult>;
  previous: Map<string, DocumentTreeResult>;
}

const states = new WeakMap<TopikContentCache, CacheState>();
const BUILT_IN_COUNT = Object.keys(components).length;

/** @internal */
export function createTopikContentCache(): TopikContentCache {
  const cache = Object.freeze({}) as TopikContentCache;
  states.set(cache, { current: new Map(), previous: new Map() });
  return cache;
}

/**
 * @internal Drops every document no call read since the previous prune. A caller that keeps
 * a cache across batches, such as a watcher across compilations, prunes after each batch, so
 * the cache holds at most the documents of the last two.
 */
export function pruneTopikContentCache(cache: TopikContentCache): void {
  const state = states.get(cache);
  if (state === undefined) return;
  state.previous = state.current;
  state.current = new Map();
}

/**
 * Freezes every object of a parsed tree; the parser produces only plain data. With `verified`,
 * also records each node as within the data limits, so later checks of it can be skipped.
 */
function deepFreeze(root: unknown, verified: boolean): void {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) continue;
    Object.freeze(value);
    // Checks start at nodes, so only nodes are recorded.
    if (verified && typeof (value as { type?: unknown }).type === "string") markVerifiedData(value);
    for (const key of Object.keys(value)) stack.push((value as Record<string, unknown>)[key]);
  }
}

/**
 * @internal Parse `source` with a resolved `registry`, or return the shared result of an
 * earlier parse in `cache`. Otherwise parses afresh and returns a tree the caller may change.
 */
export function parseCachedDocumentTree(
  source: string,
  registry: Registry,
  cache: TopikContentCache | undefined,
): DocumentTreeResult {
  const state = cache === undefined ? undefined : states.get(cache);
  // A resolved registry always holds every built-in component, under its canonical definition.
  if (state === undefined || Object.keys(registry).length !== BUILT_IN_COUNT)
    return parseDocumentTree(source, registry);
  let result = state.current.get(source) ?? state.previous.get(source);
  if (result !== undefined) state.current.set(source, result);
  else {
    result = parseDocumentTree(source, registry);
    // The parser indexes a document only after it passed the data and tree limits.
    if (result.document !== undefined) deepFreeze(result.document, result.index !== undefined);
    Object.freeze(result.diagnostics);
    for (const diagnostic of result.diagnostics) Object.freeze(diagnostic);
    state.current.set(source, result);
  }
  return result;
}
