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
  const [hydrated, setHydrated] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(presentation?.wrap ?? false);
  const [copied, setCopied] = useState(false);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const collapseAfter = presentation?.collapseAfter;
  const collapsed = hydrated && collapseAfter !== undefined && !expanded;
  const hasDiff = Boolean(presentation?.added?.length || presentation?.removed?.length);

  useEffect(() => {
    setHydrated(true);
    return () => clearTimeout(copyTimeout.current);
  }, []);

  useEffect(() => {
    setExpanded(false);
    setCopied(false);
    clearTimeout(copyTimeout.current);
  }, [payload, collapseAfter]);

  useEffect(() => setWrap(presentation?.wrap ?? false), [presentation?.wrap]);

  async function copyCode() {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
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
            onClick={() => setWrap((value) => !value)}
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
            : rows.map((text, index) => {
                const line = index + 1;
                const added = includesLine(presentation?.added, line);
                const removed = includesLine(presentation?.removed, line);
                return (
                  <span
                    className="topik-code-block__row"
                    data-diff={added ? "added" : removed ? "removed" : undefined}
                    data-focused={
                      presentation?.focus ? includesLine(presentation.focus, line) : undefined
                    }
                    data-highlighted={includesLine(presentation?.highlight, line) || undefined}
                    data-line={line}
                    hidden={collapsed && index >= (collapseAfter ?? rows.length)}
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
                        : text}
                      {index < rows.length - 1 || content.endsWith("\n") ? "\n" : null}
                    </span>
                  </span>
                );
              })}
        </code>
      </pre>
      {collapseAfter !== undefined ? (
        <button
          aria-controls={rowsId}
          aria-expanded={!collapsed}
          className="topik-code-block__expand"
          disabled={!hydrated}
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {collapsed ? `Show all ${rows.length} lines` : "Show fewer lines"}
        </button>
      ) : null}
    </div>
  );
}
