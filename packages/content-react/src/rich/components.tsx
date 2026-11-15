import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type DependencyList,
  type ReactNode,
} from "react";
import { useTopikColorScheme } from "../core/context";
import { safeDiagramSvg } from "./diagram-svg";
import { withDiagramMath } from "./diagram-math";
import { pageMathOptions } from "./page-math";
import { TopikMath, TopikMathInline, TopikMermaid } from "../theme/components";
import {
  mergeTopikComponentOverrides,
  type TopikComponentMap,
  type TopikComponentProps,
} from "../core/components";
import { CodeBlockView, type CodeHighlight } from "../theme/code-block";
import { highlightCode } from "./code-highlight";
import {
  CODE_PRESENTATION_LIMITS,
  CONTENT_LIMITS,
  type CodePresentationEffectiveOptions,
} from "@topik/content";

export type RichTopikTheme = "light" | "dark";

/**
 * Regular-expression engine for Shiki highlighting.
 *
 * `"oniguruma"` (the default) uses WebAssembly, so a Content-Security-Policy must allow
 * `'wasm-unsafe-eval'` in `script-src`. `"javascript"` uses native regular expressions and never
 * loads WebAssembly; a grammar it cannot run leaves that block as plain code.
 */
export type RichTopikCodeHighlightEngine = "oniguruma" | "javascript";

interface HtmlState {
  html: string;
  status: "error" | "loading" | "rendered";
}

const emptyTopikComponents: Partial<TopikComponentMap> = {};
const defaultRichTopikTheme: RichTopikTheme = "light";
// Undefined follows the content color scheme; an explicit theme always wins.
const RichTopikThemeContext = createContext<RichTopikTheme | undefined>(undefined);
// Undefined inherits an enclosing provider's engine, then the WebAssembly default.
const RichTopikCodeHighlightEngineContext = createContext<RichTopikCodeHighlightEngine | undefined>(
  undefined,
);
const shikiThemes = {
  light: "github-light",
  dark: "github-dark",
} as const satisfies Record<RichTopikTheme, string>;
const minimumMermaidLoadingDurationMs = 300;

export function RichTopikThemeProvider({
  children,
  theme,
  codeHighlightEngine,
}: {
  children: ReactNode;
  theme?: RichTopikTheme;
  /** Shiki regular-expression engine; defaults to `"oniguruma"` (WebAssembly). */
  codeHighlightEngine?: RichTopikCodeHighlightEngine;
}) {
  const inherited = useContext(RichTopikThemeContext);
  const inheritedEngine = useContext(RichTopikCodeHighlightEngineContext);
  return (
    <RichTopikThemeContext.Provider value={theme ?? inherited}>
      <RichTopikCodeHighlightEngineContext.Provider value={codeHighlightEngine ?? inheritedEngine}>
        {children}
      </RichTopikCodeHighlightEngineContext.Provider>
    </RichTopikThemeContext.Provider>
  );
}

function useRichTopikTheme(): RichTopikTheme {
  const explicit = useContext(RichTopikThemeContext);
  const colorScheme = useTopikColorScheme();
  return explicit ?? colorScheme ?? defaultRichTopikTheme;
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Plain text of authored children, matching the themed code block's fallback. */
function stringChildren(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child))
        return stringChildren(child.props.children);
      return "";
    })
    .join("");
}

function escapedCodeLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index++) {
    switch (value.charCodeAt(index)) {
      case 34:
      case 39:
        length += 6;
        break;
      case 38:
        length += 5;
        break;
      case 60:
      case 62:
        length += 4;
        break;
      default:
        length++;
    }
  }
  return length;
}

async function withMinimumDelay<T>(load: () => Promise<T>, delayMs: number): Promise<T> {
  const [result] = await Promise.allSettled([
    load(),
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  ]);
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function useRenderedHtml(load: () => Promise<string>, deps: DependencyList): HtmlState {
  const [state, setState] = useState<HtmlState>({ html: "", status: "loading" });
  const [previousDeps, setPreviousDeps] = useState(deps);

  if (
    deps.length !== previousDeps.length ||
    deps.some((dependency, index) => !Object.is(dependency, previousDeps[index]))
  ) {
    setPreviousDeps(deps);
    setState({ html: "", status: "loading" });
  }

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((html) => {
        if (!cancelled) setState({ html, status: "rendered" });
      })
      .catch((error: unknown) => {
        console.warn("Failed to render rich content", error);
        if (!cancelled) setState({ html: "", status: "error" });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

export function RichTopikCodeBlock(props: TopikComponentProps) {
  const code =
    stringAttribute(props.content) ??
    (typeof props.payload === "string" ? `${props.payload}\n` : stringChildren(props.children));
  const payload =
    stringAttribute(props.payload) ?? (code.endsWith("\n") ? code.slice(0, -1) : code);
  const language = stringAttribute(props.language) ?? "text";
  const theme = useRichTopikTheme();
  const engine = useContext(RichTopikCodeHighlightEngineContext) ?? "oniguruma";
  const presented = Boolean(props.presentation);
  const foldCount =
    (props.presentation as CodePresentationEffectiveOptions | undefined)?.collapse?.length ?? 0;
  const [rendered, setRendered] = useState<{
    payload: string;
    language: string;
    theme: RichTopikTheme;
    engine: RichTopikCodeHighlightEngine;
    presented: boolean;
    foldCount: number;
    highlight: CodeHighlight;
  }>();

  useEffect(() => {
    let cancelled = false;
    // Large ordinary fences stay efficient plain text; avoid allocating Shiki rows at all.
    let rowCount = 1;
    for (let index = 0; index < payload.length; index++) {
      if (payload.charCodeAt(index) === 10 && ++rowCount > CODE_PRESENTATION_LIMITS.rows) return;
    }
    void highlightCode(payload, { lang: language, theme: shikiThemes[theme], engine })
      .then((highlight) => {
        const rows = payload.split("\n");
        if (highlight.tokens.length !== rows.length) {
          throw new Error("Syntax highlighting changed physical code rows");
        }
        // Keep token spans within the reserved decoration allowance before React allocates them.
        let decorationLength = 0;
        for (const [index, tokens] of highlight.tokens.entries()) {
          let offset = 0;
          for (const token of tokens) {
            if (!rows[index].startsWith(token.content, offset)) {
              throw new Error("Syntax highlighting changed code text");
            }
            offset += token.content.length;
            if (token.color && !/^#[\da-f]{3,8}$/i.test(token.color)) {
              throw new Error("Unsupported syntax token color");
            }
            if (
              (token.color && token.color.toLowerCase() !== highlight.fg?.toLowerCase()) ||
              token.fontStyle
            ) {
              decorationLength +=
                32 +
                (token.color?.length ?? 0) +
                (token.fontStyle && token.fontStyle & 1 ? 18 : 0) +
                (token.fontStyle && token.fontStyle & 2 ? 17 : 0) +
                (token.fontStyle && token.fontStyle & 4 ? 27 : 0);
            }
          }
          if (offset !== rows[index].length) {
            throw new Error("Syntax highlighting changed code text");
          }
        }
        // Reuse the unused worst-case text escaping allowance for syntax spans.
        // Leave 512 units per row, 768 per fold control and 2048 per block for markup.
        const escapedLength = escapedCodeLength(payload);
        const decorationBudget = Math.min(
          2048 + rows.length * 256 + payload.length * 6 - escapedLength,
          CONTENT_LIMITS.presentationOutputLength -
            escapedLength -
            2048 -
            (presented ? rows.length * 512 : 0) -
            foldCount * 768,
        );
        if (decorationLength > decorationBudget) {
          throw new Error("Syntax highlighting exceeds the code decoration budget");
        }
        if (!cancelled)
          setRendered({ payload, language, theme, engine, presented, foldCount, highlight });
      })
      .catch(() => {
        console.warn("Failed to highlight code; using plain code");
      });
    return () => {
      cancelled = true;
    };
  }, [payload, language, theme, engine, presented, foldCount]);

  const highlight =
    rendered?.payload === payload &&
    rendered.language === language &&
    rendered.theme === theme &&
    rendered.engine === engine &&
    rendered.presented === presented &&
    rendered.foldCount === foldCount
      ? rendered.highlight
      : undefined;

  return (
    <div className="topik-rich-code-block">
      <div className="topik-rich-code-block__frame">
        <CodeBlockView
          payload={payload}
          content={code}
          language={stringAttribute(props.language)}
          presentation={props.presentation as CodePresentationEffectiveOptions | undefined}
          highlight={highlight}
          rich
        />
      </div>
    </div>
  );
}

export function RichTopikMath(props: TopikComponentProps) {
  const content = stringAttribute(props.content) ?? "";
  const rendered = useRenderedHtml(async () => {
    const katex = await import("katex");
    return katex.renderToString(content, pageMathOptions(true));
  }, [content]);

  if (!rendered.html) return <TopikMath {...props} />;
  return <div className="topik-rich-math" dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

export function RichTopikMathInline(props: TopikComponentProps) {
  const content = stringAttribute(props.content) ?? "";
  const rendered = useRenderedHtml(async () => {
    const katex = await import("katex");
    return katex.renderToString(content, pageMathOptions(false));
  }, [content]);

  if (!rendered.html) return <TopikMathInline {...props} />;
  return (
    <span className="topik-rich-math-inline" dangerouslySetInnerHTML={{ __html: rendered.html }} />
  );
}

export function RichTopikMermaid(props: TopikComponentProps) {
  const content = stringAttribute(props.content) ?? "";
  const theme = useRichTopikTheme();
  const id = useId().replace(/:/g, "-");
  const rendered = useRenderedHtml(
    () =>
      withMinimumDelay(async () => {
        const { render } = await import("pele");
        const result = await withDiagramMath(content, (math) =>
          render(content, {
            idPrefix: `topik-mermaid-${id}`,
            links: false,
            images: false,
            maxEdges: 500,
            limit: 50_000,
            outputLimit: 4_000_000,
            responsive: true,
            autoDirection: false,
            math,
          }),
        );
        return safeDiagramSvg(result.svg);
      }, minimumMermaidLoadingDurationMs),
    [content, id],
  );

  if (rendered.status === "loading") {
    return (
      <div className="topik-rich-mermaid topik-rich-mermaid--loading" role="status">
        <span className="topik-rich-mermaid__status">Rendering diagram…</span>
      </div>
    );
  }
  if (rendered.status === "error") return <TopikMermaid {...props} />;
  return (
    <div
      className="topik-rich-mermaid"
      data-theme={theme}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}

export const richTopikComponents = {
  TopikCodeBlock: RichTopikCodeBlock,
  TopikMath: RichTopikMath,
  TopikMathInline: RichTopikMathInline,
  TopikMermaid: RichTopikMermaid,
} satisfies Partial<TopikComponentMap>;

export function useRichTopikComponents(
  overrides: Partial<TopikComponentMap> = emptyTopikComponents,
): Partial<TopikComponentMap> {
  return useMemo(() => mergeTopikComponentOverrides(richTopikComponents, overrides), [overrides]);
}
