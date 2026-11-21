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
/** Footnote lookups serialize and normalize the label: a few operations per character. */
const SERIALIZE_WEIGHT = 4;
/** Merging a data run moves the events after it in one shift, cheaper than a walk. */
const MERGE_DIVISOR = 4;
const BLANK_LINE = /^[ \t]*$/u;
/** Flow that a lazy line cannot continue: headings, fences, HTML, breaks, tables, code. */
const BLOCK_START = /^(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|<|(?:[-*_][ \t]*){3,}$|\|)/u;
const QUOTE_MARKER = /^ {0,3}>[ \t]?/u;
const ITEM_MARKER = /^ {0,3}(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]+|$)/u;
/** A GFM footnote definition, a container like a list item. */
const FOOTNOTE_MARKER = /^ {0,3}\[\^[^\]\s]{1,999}\]:[ \t]?/u;
/** A thematic break such as `* * *` is not a list item, though it starts like one. */
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const startsItem = (text: string) => ITEM_MARKER.test(text) && !THEMATIC_BREAK.test(text);

/** One-based line access into the normalized (LF) source. */
function sourceLines(source: string) {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1))
    starts.push(index + 1);
  return {
    text: (line: number) =>
      line < 1 || line > starts.length
        ? ""
        : source.slice(starts[line - 1], line < starts.length ? starts[line] - 1 : source.length),
  };
}

const leadingSpaces = (text: string) => text.length - text.trimStart().length;

/**
 * Follow block quotes and list items line by line, as the CommonMark document parser opens
 * and continues them, to tell when micromark rewrites its event list. Columns count tabs as
 * one character: the model only estimates parser work and never decides the parse.
 */
function containerModel() {
  type Open = { quote: true } | { quote: false; content: number };
  let stack: Open[] = [];
  /** Lines of the paragraph a lazy line would continue; 0 after a blank line or a block. */
  let paragraph = 0;
  const open = (rest: string, column: number) => {
    for (;;) {
      const quote = QUOTE_MARKER.exec(rest);
      if (quote) {
        stack.push({ quote: true });
        column += quote[0].length;
        rest = rest.slice(quote[0].length);
        continue;
      }
      const footnote = FOOTNOTE_MARKER.exec(rest);
      if (footnote) {
        // A footnote definition continues on lines indented four columns past its start.
        stack.push({ quote: false, content: column + leadingSpaces(rest) + 4 });
        column += footnote[0].length;
        rest = rest.slice(footnote[0].length);
        continue;
      }
      const item = startsItem(rest) ? ITEM_MARKER.exec(rest) : null;
      if (!item || (BLANK_LINE.test(rest.slice(item[0].length)) && stack.length === 0)) return rest;
      column += item[0].length;
      stack.push({ quote: false, content: column });
      rest = rest.slice(item[0].length);
    }
  };
  return {
    line(text: string, lazy: boolean): { rewrite: boolean; walk: number } {
      const blank = BLANK_LINE.test(text);
      let rest = text;
      let column = 0;
      let continued = 0;
      let sibling = false;
      for (; continued < stack.length; continued++) {
        const container = stack[continued];
        if (container.quote) {
          const marker = QUOTE_MARKER.exec(rest);
          if (!marker) break;
          column += marker[0].length;
          rest = rest.slice(marker[0].length);
          continue;
        }
        if (blank) continue;
        const indent = leadingSpaces(rest);
        if (column + indent >= container.content) {
          const skip = container.content - column;
          column += skip;
          rest = rest.slice(skip);
          continue;
        }
        // A new item of the same list continues it, closing what was nested in the item.
        sibling = startsItem(rest) && !BLANK_LINE.test(rest.replace(ITEM_MARKER, ""));
        break;
      }
      const nested = stack.length - continued - 1;
      const previous = paragraph;
      let rewrite = false;
      let walk = 0;
      if (sibling) {
        rewrite = nested > 0;
        stack = stack.slice(0, continued);
        rest = open(rest, column);
      } else if (continued < stack.length && !blank && lazy) {
        // A lazy line keeps the containers when it continues the open paragraph.
        if (previous > 0 && !BLOCK_START.test(rest.trimStart())) walk = previous;
        else rewrite = true;
        if (rewrite) stack = stack.slice(0, continued);
      } else {
        // A blank line that ends a block quote is lazy and moves its exits back as well.
        if (continued < stack.length && lazy) rewrite = true;
        stack = stack.slice(0, continued);
        if (!blank) rest = open(rest, column);
      }
      const content = rest.trimStart();
      paragraph = walk
        ? previous + 1
        : blank || BLANK_LINE.test(content) || BLOCK_START.test(content) || leadingSpaces(rest) >= 4
          ? 0
          : sibling || continued < stack.length
            ? 1
            : paragraph + 1;
      return { rewrite, walk };
    },
  };
}

/** Tokens that end the GFM footnote tokenizer's backward search for a `![`. */
const FOOTNOTE_STOPS = new Set([
  "gfmFootnoteCall",
  "image",
  "label",
  "labelImage",
  "labelLink",
  "link",
]);

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
  /** Runs of adjacent data tokens, each merged by splicing the event list. */
  merges: number;
  /** Footnote search cursor: events scanned, the last of them and the latest stop. */
  scanned: number;
  last: unknown;
  stop: number;
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
 * - The GFM footnote tokenizer walks back from every label end to the latest
 *   label, link or image token, then may serialize from a balanced `![`.
 * - Brackets and escapes that end up as text split data into runs, and text
 *   resolution merges each run by splicing the event list.
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
  const cost = (state: TextState, to: number) => {
    const events =
      state.events +
      CONSTRUCT_EVENTS +
      LINE_EVENTS * (to > state.from ? index.lineEndings(state.from, to) : 0);
    return (
      state.closers * (events + MATCH_EVENTS * state.closers) +
      Math.ceil((state.merges * events) / MERGE_DIVISOR)
    );
  };
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
          (state = {
            closers: 0,
            merges: 0,
            scanned: 0,
            last: undefined,
            stop: -1,
            events: 0,
            from: offset,
            to: offset,
            charged: 0,
          }),
        );
      const events = this.events;
      if (active !== state) {
        // The previous paragraph has been resolved and ends before this one
        // starts: keep only the lines its final construct actually covered.
        const start = events[0]?.[1].start.offset ?? offset;
        if (active?.charged) {
          const actual = cost(active, Math.min(active.to, start));
          if (actual < active.charged) {
            work -= active.charged - actual;
            active.charged = actual;
          }
        }
        active = state;
      }
      // Only the text initializer adds data, and only for a break that no
      // construct took, so at most one data token is new since the last break.
      // Count a run when it reaches a second token.
      const length = events.length;
      if (
        length >= 4 &&
        events[length - 1][1].type === "data" &&
        events[length - 3][1].type === "data" &&
        (length === 4 || events[length - 5][1].type !== "data")
      )
        state.merges++;
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
        // The footnote call tokenizer repeats this backward walk after every
        // failed label end, so charge the walk it is about to make.
        // Resolved links splice the tail, so resume only from an intact event.
        let stop = length;
        if (state.scanned && state.scanned <= length && events[state.scanned - 1] === state.last) {
          stop = state.stop;
          for (let event = state.scanned; event < length; event++)
            if (FOOTNOTE_STOPS.has(events[event][1].type)) stop = event;
        } else while (--stop >= 0 && !FOOTNOTE_STOPS.has(events[stop][1].type)) continue;
        state.scanned = length;
        state.last = events[length - 1];
        state.stop = stop;
        spend(length - stop);
        const token = events[stop]?.[1];
        if (token?.type === "labelImage" && token._balanced)
          spend(SERIALIZE_WEIGHT * (offset - token.end.offset));
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
      state.events = length;
      state.from = offset;
      state.to = end;
      const target = state.closers || state.merges ? cost(state, end) : 0;
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
  // micromark copies the document's whole event list each time it moves container exits back
  // (a lazy line that ends containers, or a sibling list item that closes containers nested in
  // the previous item), and walks back over the open paragraph for every lazy line that
  // continues it. None of this happens in a paragraph's text: charge it as lines start.
  const lines = sourceLines(source);
  const model = containerModel();
  let seen = 0;
  const lazyGuard: Tokenizer = function (_effects, _ok, nok) {
    return (code) => {
      const current = this.now().line;
      while (seen < current - 1) {
        const line = ++seen;
        const lazy = Boolean(this.parser.lazy[line]);
        const step = model.line(lines.text(line), lazy);
        // A lazy line the model cannot place may rewrite the event list: charge it as one.
        if (step.rewrite || (lazy && !step.walk)) spend(this.events.length);
        else if (step.walk) spend(LINE_EVENTS * step.walk);
      }
      return nok(code);
    };
  };
  return {
    document: {
      ...Object.fromEntries(
        "*+->0123456789"
          .split("")
          .map((marker) => [marker.charCodeAt(0), { tokenize: containerGuard }]),
      ),
      null: { tokenize: lazyGuard },
    },
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
