import type { Code } from "mdast";
import {
  defaultHandlers,
  type Options,
  type SafeConfig,
  type State,
  type Unsafe,
} from "mdast-util-to-markdown";
import { CONTENT_LIMITS, ContentLimitError } from "./limits.js";

/*!
 * @license MIT
 * Header escaping follows mdast-util-to-markdown's safe utility, with linear
 * offset storage and emission rather than repeated array membership searches.
 * Copyright (c) Titus Wormer <tituswormer@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const punctuation = /[!-/:-@[-`{-~]/;
const marked = 1;
const before = 2;
const after = 4;

function overflow(): never {
  throw new ContentLimitError(
    `Content exceeds the source length limit of ${CONTENT_LIMITS.sourceLength}`,
  );
}

/** Match the existing ordinary-code fence choice without allocating its spelling. */
export function ordinaryCodeFenceLength(value: string, marker: "`" | "~" = "`"): number {
  let length = 3;
  let run = 0;
  for (let index = 0; index < value.length; index++) {
    run = value[index] === marker ? run + 1 : 0;
    length = Math.max(length, run + 1);
  }
  return length;
}

function inScope(stack: State["stack"], scope: Unsafe["inConstruct"], absent: boolean): boolean {
  if (!scope || !scope.length) return absent;
  return (typeof scope === "string" ? [scope] : scope).some((name) => stack.includes(name));
}

/** Emit normal backslash escaping without constructing a separate expanded span. */
function* literalChunks(
  value: string,
  start: number,
  end: number,
  next: string,
): Generator<string> {
  let chunk = start;
  for (let index = start; index < end; index++) {
    if (
      value[index] !== "\\" ||
      !punctuation.test(index + 1 < end ? value[index + 1] : (next[0] ?? ""))
    )
      continue;
    yield value.slice(chunk, index + 1);
    yield "\\";
    chunk = index + 1;
  }
  yield value.slice(chunk, end);
}

function* headerChunks(
  value: string,
  flags: Uint8Array,
  start: number,
  end: number,
  config: SafeConfig,
): Generator<string> {
  let literal = start;
  for (let index = start; index < end; index++) {
    const current = flags[index];
    if (!(current & marked)) continue;
    const next = index + 1 < end ? flags[index + 1] : 0;
    const previous = index > 0 ? flags[index - 1] : 0;
    if (
      (next & marked && current & after && !(next & (before | after))) ||
      (previous & marked && current & before && !(previous & (before | after)))
    )
      continue;
    yield* literalChunks(value, literal, index, "\\");
    const character = value[index];
    if (punctuation.test(character) && !config.encode?.includes(character)) {
      yield "\\";
      literal = index;
    } else {
      yield `&#x${value.charCodeAt(index).toString(16).toUpperCase()};`;
      literal = index + 1;
    }
  }
  yield* literalChunks(value, literal, end, config.after);
}

function escapedHeader(
  state: State,
  input: string | null | undefined,
  config: SafeConfig,
  remaining: number,
): string {
  const prefix = config.before || "";
  const payload = input || "";
  const suffix = config.after || "";
  if (prefix.length + payload.length + suffix.length > CONTENT_LIMITS.sourceLength) overflow();
  const value = prefix + payload + suffix;
  const flags = new Uint8Array(value.length);
  for (const pattern of state.unsafe) {
    if (
      !inScope(state.stack, pattern.inConstruct, true) ||
      inScope(state.stack, pattern.notInConstruct, false)
    )
      continue;
    const expression = state.compilePattern(pattern);
    let match: RegExpExecArray | null;
    while ((match = expression.exec(value))) {
      const hasBefore = "before" in pattern || Boolean(pattern.atBreak);
      const offset = match.index + (hasBefore ? match[1].length : 0);
      const bits = marked | (hasBefore ? before : 0) | ("after" in pattern ? after : 0);
      // Repeated matches loosen a condition exactly as the baseline writer does.
      flags[offset] = flags[offset] ? flags[offset] & bits : bits;
    }
  }
  const start = prefix.length;
  const end = value.length - suffix.length;
  let length = 0;
  for (const chunk of headerChunks(value, flags, start, end, config)) {
    length += chunk.length;
    if (length > remaining) overflow();
  }
  return Array.from(headerChunks(value, flags, start, end, config)).join("");
}

/** Keep the default handler's spelling and tracker, bounding only code headers. */
export function codeWriterExtension(): NonNullable<Options["extensions"]>[number] {
  return {
    handlers: {
      code(node, parent, state, info) {
        const code = node as Code;
        // Topik requests fences. Leave optional host indented-code behavior intact.
        if (state.options.fences === false && !code.lang)
          return defaultHandlers.code(node, parent, state, info);
        const marker = state.options.fence || "`";
        if (marker !== "`" && marker !== "~")
          return defaultHandlers.code(node, parent, state, info);
        const raw = code.value || "";
        const base =
          2 * ordinaryCodeFenceLength(raw, marker) +
          1 +
          (raw ? raw.length + 1 : 0) +
          (code.lang && code.meta ? 1 : 0);
        if (base > CONTENT_LIMITS.sourceLength) overflow();
        let remaining = CONTENT_LIMITS.sourceLength - base;
        const previous = state.safe;
        state.safe = (input, config) => {
          let escaped = escapedHeader(state, input, config, remaining);
          // Literal AST headers must not become presentation attributes on reparse.
          // Parsed presentation options have their own handler and readable spelling.
          if (
            typeof input === "string" &&
            /^(?:(?:lines|wrap)(?=[ \t=]|$)|(?:filename|title|startLine|highlight|focus|collapseAfter|added|removed)(?=[ \t=]|$))/.test(
              input,
            ) &&
            escaped[0] === input[0]
          )
            escaped = `&#${input.charCodeAt(0)};${escaped.slice(1)}`;
          if (escaped.length > remaining) overflow();
          remaining -= escaped.length;
          return escaped;
        };
        try {
          return defaultHandlers.code(node, parent, state, info);
        } finally {
          state.safe = previous;
        }
      },
    },
  };
}
