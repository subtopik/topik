import type { Extension, TokenizeContext, Tokenizer } from "micromark-util-types";
import { CONTENT_LIMITS, ContentLimitError } from "./limits.js";

/** Refuse expensive syntax before micromark resolves containers and inline delimiters. */
export function parserLimitSyntax(source: string): Extension {
  let steps = 0;
  const containers = new WeakMap<
    TokenizeContext,
    { index: number; last: unknown; depth: number }
  >();
  const guard: Tokenizer = function (_effects, _ok, nok) {
    return (code) => {
      // Distinct unmatched code delimiters repeatedly scan the remaining source.
      // Weight those attempts by run length, while code payloads remain opaque.
      let weight = 1;
      if (code === 96) {
        const offset = this.now().offset;
        while (source[offset + weight] === "`") weight++;
      }
      steps += weight;
      if (steps > CONTENT_LIMITS.parserSteps)
        throw new ContentLimitError(
          `Content exceeds the parser step limit of ${CONTENT_LIMITS.parserSteps}`,
        );
      return nok(code);
    };
  };
  const containerGuard: Tokenizer = function (_effects, _ok, nok) {
    return (code) => {
      const events = this.events;
      const previous = containers.get(this);
      // Speculative constructs may rewind events. Reuse a count only when the
      // last scanned event still occupies its original slot.
      const state =
        previous && previous.index <= events.length && events[previous.index - 1] === previous.last
          ? previous
          : { index: 0, last: undefined, depth: 0 };
      for (; state.index < events.length; state.index++) {
        const [action, token] = events[state.index];
        const weight =
          token.type === "blockQuote"
            ? 1
            : token.type === "listOrdered" || token.type === "listUnordered"
              ? 2
              : 0;
        state.depth += action === "enter" ? weight : -weight;
      }
      state.last = events.at(-1);
      containers.set(this, state);
      if (state.depth >= CONTENT_LIMITS.treeDepth)
        throw new ContentLimitError(
          `Content exceeds the tree depth limit of ${CONTENT_LIMITS.treeDepth}`,
        );
      return nok(code);
    };
  };
  return {
    document: Object.fromEntries(
      "*+->0123456789"
        .split("")
        .map((marker) => [marker.charCodeAt(0), { tokenize: containerGuard }]),
    ),
    text: {
      ...Object.fromEntries(
        "!*[_~".split("").map((marker) => [marker.charCodeAt(0), { tokenize: guard }]),
      ),
      96: {
        tokenize: guard,
        // Keep the core code-span boundary: an unescaped delimiter cannot
        // restart inside a run that already failed to find a closing match.
        previous(code) {
          return code !== 96 || this.events.at(-1)?.[1].type === "characterEscape";
        },
      },
    },
  };
}
