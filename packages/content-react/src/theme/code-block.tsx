import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CodePresentationEffectiveOptions } from "@topik/content";

export interface CodeToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

export interface CodeHighlight {
  tokens: CodeToken[][];
  fg?: string;
  bg?: string;
}

interface CodeBlockViewProps {
  payload: string;
  content: string;
  language?: string;
  presentation?: CodePresentationEffectiveOptions;
  highlight?: CodeHighlight;
  rich?: boolean;
}

type CodeViewKey = readonly [payload: string, content: string, options: string];

interface CodeViewState {
  key: CodeViewKey;
  expanded: Set<number>;
  wrap: boolean;
  copied: boolean;
}

function sameView(state: CodeViewState, key: CodeViewKey): boolean {
  return state.key.every((value, index) => value === key[index]);
}

function includesLine(intervals: [number, number][] | undefined, line: number): boolean {
  if (!intervals) return false;
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const [start, end] = intervals[middle];
    if (line < start) high = middle - 1;
    else if (line > end) low = middle + 1;
    else return true;
  }
  return false;
}

function tokenStyle(token: CodeToken): CSSProperties {
  return {
    color: token.color,
    fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
    fontWeight: token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
    textDecoration: token.fontStyle && token.fontStyle & 4 ? "underline" : undefined,
  };
}

function highlightedCode(
  rows: CodeToken[][],
  foreground: string | undefined,
  trailingSeparator: boolean,
): ReactNode[] {
  const children: ReactNode[] = [];
  let plain = "";
  for (const [index, tokens] of rows.entries()) {
    for (const token of tokens) {
      if (!token.content) continue;
      if (
        (!token.color || token.color.toLowerCase() === foreground?.toLowerCase()) &&
        !token.fontStyle
      ) {
        plain += token.content;
      } else {
        if (plain) children.push(plain);
        plain = "";
        children.push(
          <span key={children.length} style={tokenStyle(token)}>
            {token.content}
          </span>,
        );
      }
    }
    if (index < rows.length - 1 || trailingSeparator) plain += "\n";
  }
  if (plain) children.push(plain);
  return children;
}

/** Shared row and controls implementation; highlighting never owns code text or UI state. */
export function CodeBlockView({
  payload,
  content,
  language,
  presentation,
  highlight,
  rich = false,
}: CodeBlockViewProps) {
  const id = useId();
  const rowsId = `${id}-code`;
  const legendId = `${id}-diff`;
  const headingId = `${id}-heading`;
  // Ordinary fences remain a single text node until bounded highlighting succeeds.
  const rows = presentation ? payload.split("\n") : [];
  const lineNumberWidth = presentation?.lineNumbers
    ? `${String((presentation.startLine ?? 1) + rows.length - 1).length}ch`
    : undefined;
  const optionsKey = JSON.stringify(presentation ?? null);
  const viewKey: CodeViewKey = [payload, content, optionsKey];
  const initialView = (): CodeViewState => ({
    key: viewKey,
    expanded: new Set(),
    wrap: presentation?.wrap ?? false,
    copied: false,
  });
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState(initialView);
  // Reset before committing new content/options, rather than briefly using old row ranges.
  const currentView = sameView(view, viewKey) ? view : initialView();
  if (currentView !== view) setView(currentView);
  const { wrap, copied } = currentView;
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copySequence = useRef(0);
  const collapse = presentation?.collapse ?? [];
  const hasDiff = Boolean(presentation?.added?.length || presentation?.removed?.length);

  useEffect(() => {
    setHydrated(true);
    return () => clearTimeout(copyTimeout.current);
  }, []);

  useEffect(() => {
    copySequence.current++;
    clearTimeout(copyTimeout.current);
  }, [payload, content, optionsKey]);

  async function copyCode() {
    if (!navigator.clipboard) return;
    const sequence = ++copySequence.current;
    try {
      await navigator.clipboard.writeText(content);
      if (sequence !== copySequence.current) return;
      setView((state) => (sameView(state, viewKey) ? { ...state, copied: true } : state));
      clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => {
        setView((state) => (sameView(state, viewKey) ? { ...state, copied: false } : state));
      }, 1600);
    } catch {
      if (sequence === copySequence.current)
        setView((state) => (sameView(state, viewKey) ? { ...state, copied: false } : state));
    }
  }

  function toggleRegion(index: number) {
    setView((state) => {
      const next = sameView(state, viewKey) ? state : initialView();
      const expanded = new Set(next.expanded);
      if (expanded.has(index)) expanded.delete(index);
      else expanded.add(index);
      return { ...next, expanded };
    });
  }

  function renderRow(index: number): ReactNode {
    const line = index + 1;
    const added = includesLine(presentation?.added, line);
    const removed = includesLine(presentation?.removed, line);
    return (
      <span
        className="topik-code-block__row"
        data-diff={added ? "added" : removed ? "removed" : undefined}
        data-focused={presentation?.focus ? includesLine(presentation.focus, line) : undefined}
        data-highlighted={includesLine(presentation?.highlight, line) || undefined}
        data-line={line}
        key={index}
      >
        {presentation?.lineNumbers ? (
          <span aria-hidden="true" className="topik-code-block__line-number">
            {(presentation.startLine ?? 1) + index}
          </span>
        ) : null}
        {hasDiff ? (
          <span aria-hidden="true" className="topik-code-block__diff-marker">
            {added ? "+" : removed ? "−" : " "}
          </span>
        ) : null}
        {added || removed ? (
          <span className="topik-code-block__sr-only">
            {added ? "Added line: " : "Removed line: "}
          </span>
        ) : null}
        <span className="topik-code-block__text">
          {highlight
            ? highlightedCode([highlight.tokens[index]], highlight.fg, false)
            : rows[index]}
          {index < rows.length - 1 || content.endsWith("\n") ? "\n" : null}
        </span>
      </span>
    );
  }

  function renderPresentedRows(): ReactNode[] {
    const result: ReactNode[] = [];
    let index = 0;
    for (const [regionIndex, [start, end]] of collapse.entries()) {
      while (index < start - 1) result.push(renderRow(index++));
      const expanded = !hydrated || currentView.expanded.has(regionIndex);
      const regionId = `${id}-region-${regionIndex}`;
      const offset = presentation?.lineNumbers ? (presentation.startLine ?? 1) - 1 : 0;
      const label =
        start === end ? `line ${start + offset}` : `lines ${start + offset}–${end + offset}`;
      result.push(
        <span className="topik-code-block__fold" key={`fold-${regionIndex}`}>
          <button
            aria-controls={regionId}
            aria-expanded={expanded}
            className="topik-code-block__expand topik-code-block__fold-toggle"
            data-collapse-start={start}
            data-collapse-end={end}
            disabled={!hydrated}
            onClick={() => toggleRegion(regionIndex)}
            type="button"
          >
            {expanded ? `Hide ${label}` : `Show ${label}`}
          </button>
        </span>,
      );
      const regionRows: ReactNode[] = [];
      while (index < end) regionRows.push(renderRow(index++));
      result.push(
        <span
          className="topik-code-block__region"
          hidden={!expanded}
          id={regionId}
          key={`region-${regionIndex}`}
        >
          {regionRows}
        </span>,
      );
    }
    while (index < rows.length) result.push(renderRow(index++));
    return result;
  }

  return (
    <div
      aria-labelledby={presentation?.title ? headingId : undefined}
      className="topik-code-block"
      data-language={language}
      data-wrap={wrap}
      style={
        lineNumberWidth
          ? ({ "--topik-code-line-number-width": lineNumberWidth } as CSSProperties)
          : undefined
      }
    >
      <div className="topik-code-block__header">
        <div className="topik-code-block__labels">
          {presentation?.title ? (
            <strong className="topik-code-block__title" id={headingId}>
              {presentation.title}
            </strong>
          ) : null}
          {presentation?.filename ? (
            <span className="topik-code-block__filename">{presentation.filename}</span>
          ) : null}
          {language ? <span className="topik-code-block__language">{language}</span> : null}
        </div>
        <div className="topik-code-block__controls">
          <button
            aria-controls={rowsId}
            aria-pressed={wrap}
            disabled={!hydrated}
            onClick={() => setView((state) => ({ ...state, wrap: !state.wrap }))}
            type="button"
          >
            Wrap lines
          </button>
          <button
            className={rich ? "topik-rich-code-block__copy" : "topik-code-block__copy"}
            disabled={!hydrated}
            onClick={() => void copyCode()}
            type="button"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {hasDiff ? (
        <div className="topik-code-block__legend" id={legendId}>
          <span>+ Added line</span>
          <span>− Removed line</span>
        </div>
      ) : null}
      <pre
        aria-describedby={hasDiff ? legendId : undefined}
        className={highlight ? "shiki" : undefined}
        id={rowsId}
        style={highlight ? { color: highlight.fg, backgroundColor: highlight.bg } : undefined}
        tabIndex={0}
      >
        <code>
          {!presentation
            ? highlight
              ? highlightedCode(highlight.tokens, highlight.fg, content.endsWith("\n"))
              : content
            : renderPresentedRows()}
        </code>
      </pre>
    </div>
  );
}
