import type { Code, Extension, TokenizeContext, Tokenizer } from "micromark-util-types";
import { CONTENT_LIMITS, ContentLimitError } from "./limits.js";

/** Events a construct starting at a guarded break can add on its own line. */
const CONSTRUCT_EVENTS = 64;
/** Events a construct can add for each line ending it consumes (line ending, prefix, data). */
const LINE_EVENTS = 8;
/** Events a resolved delimiter match adds (sequence, text and group tokens). */
const MATCH_EVENTS = 8;
/** Code-span scanning advances one state per character, unlike event walks and splices. */
const CODE_SCAN_WEIGHT = 16;
/** Label resolution copies and re-resolves the label's events: at most a few per character. */
const LABEL_WEIGHT = 32;
/** Reference labels are at most 999 characters, plus their brackets. */
const REFERENCE_EXTENT = 1_003;

/**
 * Every text construct code known to the Topik grammar: CommonMark, GFM
 * strikethrough, footnotes and task lists, tags and heading IDs. Each is
 * already a break, so guarding it does not change how data is split. A guard
 * runs before every construct that can add events to a text context.
 */
const GUARDED_CODES = [-5, -4, -3, 33, 38, 42, 60, 91, 92, 93, 95, 123, 126];

interface TextState {
  /** Delimiter runs that may close, each walking and splicing every event. */
  closers: number;
  /** Events tokenized by the latest guarded break. */
  events: number;
  /** Extent of the construct starting at that break, which may add unseen lines. */
  from: number;
  to: number;
  charged: number;
}

const whitespace = (code: Code) =>
  code === null || code < 0 || /\s/.test(String.fromCharCode(code));
const alphanumeric = (code: number) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** Attempts may derive contexts from a tokenizer; resolve the tokenizer itself. */
function tokenizerOf(context: TokenizeContext): TokenizeContext {
  while (!Object.hasOwn(context, "sliceStream")) context = Object.getPrototypeOf(context);
  return context;
}

/** Index of the first value at or after `offset`, so arrays double as cursors. */
function lowerBound(values: readonly number[], offset: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Source positions the guard consults, built once per document on first use. */
function sourceIndex(source: string) {
  let lineEndings: number[] | undefined;
  let terminators: number[] | undefined;
  let closingAngles: number[] | undefined;
  let codeRuns: Map<number, number[]> | undefined;

  function lines() {
    if (lineEndings) return lineEndings;
    lineEndings = [];
    terminators = [];
    // Blank lines and ATX headings (up to three spaces of indentation) end
    // every paragraph: neither can be lazy paragraph continuation text.
    const pattern = /\r\n?|\n/g;
    let start = 0;
    for (let match = pattern.exec(source); ; match = pattern.exec(source)) {
      const end = match ? match.index : source.length;
      if (/^(?:[ \t]*|[ ]{0,3}#{1,6}(?:[ \t].*)?)$/.test(source.slice(start, end)))
        terminators.push(start);
      if (!match) break;
      lineEndings.push(match.index);
      start = match.index + match[0].length;
    }
    return lineEndings;
  }

  return {
    /** Line endings in [from, to): each may add events inside a multi-line construct. */
    lineEndings(from: number, to: number): number {
      const values = lines();
      return lowerBound(values, to) - lowerBound(values, from);
    },
    /** Upper bound for the end of the paragraph containing `offset`. */
    paragraphEnd(offset: number): number {
      lines();
      return terminators![lowerBound(terminators!, offset + 1)] ?? source.length;
    },
    /** Inline HTML and angle-bracket autolinks always end at a `>`. */
    closingAngle(offset: number): number {
      if (!closingAngles) {
        closingAngles = [];
        for (let index = source.indexOf(">"); index >= 0; index = source.indexOf(">", index + 1))
          closingAngles.push(index);
      }
      return (closingAngles[lowerBound(closingAngles, offset)] ?? source.length) + 1;
    },
    /** A code span can only close at the next maximal backtick run of the same size. */
    codeSpanEnd(offset: number, size: number): number {
      if (!codeRuns) {
        codeRuns = new Map();
        for (let index = source.indexOf("`"); index >= 0;) {
          let end = index + 1;
          while (source.charCodeAt(end) === 96) end++;
          const starts = codeRuns.get(end - index) ?? [];
          starts.push(index);
          codeRuns.set(end - index, starts);
          index = source.indexOf("`", end);
        }
      }
      const starts = codeRuns.get(size) ?? [];
      const next = starts[lowerBound(starts, offset + size)];
      return next === undefined ? source.length : next + size;
    },
  };
}

/**
 * Refuse expensive inline syntax before micromark resolves it.
 *
 * Linear syntax is free: ordinary prose, intraword underscores, matched code
 * spans and links never exhaust the budget. The guard charges the work that
 * can grow superlinearly within one paragraph (text context):
 *
 * - Attention and strikethrough resolution walk back from every possible
 *   closing delimiter run and splice the event list on each match, so every
 *   closer costs up to the final number of events in its paragraph.
 * - A code-span attempt scans to its closing run or the end of the paragraph.
 * - A label end serializes the label back to its unbalanced opening bracket.
 *
 * Event counts are read at every guarded break. Only the construct starting
 * at the latest break can add events unseen by the guard, so its extent is
 * charged in advance; once a later paragraph starts, the finished paragraph
 * keeps only the charge for its actual events. `CONTENT_LIMITS.parserSteps`
 * bounds the document total.
 */
export function parserLimitSyntax(source: string): Extension {
  let work = 0;
  const index = sourceIndex(source);
  const texts = new WeakMap<TokenizeContext, TextState>();
  const containers = new WeakMap<
    TokenizeContext,
    { index: number; last: unknown; depth: number }
  >();
  // Text contexts are tokenized and resolved one at a time, in document order.
  let active: TextState | undefined;
  const cost = (state: TextState, to: number) =>
    state.closers *
    (state.events +
      MATCH_EVENTS * state.closers +
      CONSTRUCT_EVENTS +
      LINE_EVENTS * (to > state.from ? index.lineEndings(state.from, to) : 0));
  const spend = (amount: number) => {
    work += amount;
    if (work > CONTENT_LIMITS.parserSteps)
      throw new ContentLimitError(
        `Content exceeds the parser step limit of ${CONTENT_LIMITS.parserSteps}`,
      );
  };
  const guard: Tokenizer = function (_effects, _ok, nok) {
    return (code) => {
      const offset = this.now().offset;
      const context = tokenizerOf(this);
      let state = texts.get(context);
      if (!state)
        texts.set(
          context,
          (state = { closers: 0, events: 0, from: offset, to: offset, charged: 0 }),
        );
      if (active !== state) {
        // The previous paragraph has been resolved and ends before this one
        // starts: keep only the lines its final construct actually covered.
        const start = this.events[0]?.[1].start.offset ?? offset;
        if (active?.closers) {
          const actual = cost(active, Math.min(active.to, start));
          if (actual < active.charged) {
            work -= active.charged - actual;
            active.charged = actual;
          }
        }
        active = state;
      }
      let end = offset;
      if (code === 96) {
        // Code payloads remain opaque: only the attempt's scan is charged.
        let size = 1;
        while (source.charCodeAt(offset + size) === 96) size++;
        end = Math.min(index.codeSpanEnd(offset, size), index.paragraphEnd(offset));
        spend(CODE_SCAN_WEIGHT * (end - offset));
      } else if (code === 60) {
        end = Math.min(index.closingAngle(offset), index.paragraphEnd(offset));
      } else if (code === 93) {
        const starts = this._labelStarts;
        let open = starts ? starts.length - 1 : -1;
        while (open >= 0 && starts![open]._balanced) open--;
        if (open >= 0) spend(LABEL_WEIGHT * (offset - starts![open].end.offset));
        // Resource titles may span lines up to the end of the paragraph.
        end =
          source.charCodeAt(offset + 1) === 40
            ? index.paragraphEnd(offset)
            : offset + REFERENCE_EXTENT;
      } else if (code === 42 || code === 95 || code === 126) {
        const previous = this.previous;
        let close = !whitespace(previous);
        // GFM strikethrough only starts sequences at an unescaped first tilde.
        if (code === 126 && previous === 126 && this.events.at(-1)?.[1].type !== "characterEscape")
          close = false;
        if (close && code === 95 && previous !== null && alphanumeric(previous)) {
          let after = offset + 1;
          while (source.charCodeAt(after) === 95) after++;
          // Intraword underscores can neither open nor close emphasis.
          if (alphanumeric(source.charCodeAt(after))) close = false;
        }
        if (close) state.closers++;
      }
      state.events = this.events.length;
      state.from = offset;
      state.to = end;
      const target = state.closers ? cost(state, end) : 0;
      if (target > state.charged) {
        spend(target - state.charged);
        state.charged = target;
      }
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
      ...Object.fromEntries(GUARDED_CODES.map((code) => [code, { tokenize: guard }])),
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
