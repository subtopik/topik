import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type DependencyList,
  type ReactNode,
} from "react";
import { TopikMath, TopikMathInline, TopikMermaid } from "../theme/components";
import type { TopikComponentMap, TopikComponentProps } from "../core/components";
import { CodeBlockView, type CodeHighlight } from "../theme/code-block";
import {
  CODE_PRESENTATION_LIMITS,
  CONTENT_LIMITS,
  type CodePresentationEffectiveOptions,
} from "@topik/content";

export type RichTopikTheme = "light" | "dark";

interface HtmlState {
  html: string;
  status: "error" | "loading" | "rendered";
}

const emptyTopikComponents: Partial<TopikComponentMap> = {};
const defaultRichTopikTheme: RichTopikTheme = "light";
const RichTopikThemeContext = createContext<RichTopikTheme>(defaultRichTopikTheme);
const shikiThemes = {
  light: "github-light",
  dark: "github-dark",
} satisfies Record<RichTopikTheme, string>;
const mermaidThemes = {
  light: "default",
  dark: "dark",
} satisfies Record<RichTopikTheme, string>;
const minimumMermaidLoadingDurationMs = 300;
let initializedMermaidTheme: string | undefined;

export function RichTopikThemeProvider({
  children,
  theme = defaultRichTopikTheme,
}: {
  children: ReactNode;
  theme?: RichTopikTheme;
}) {
  return <RichTopikThemeContext.Provider value={theme}>{children}</RichTopikThemeContext.Provider>;
}

function useRichTopikTheme(): RichTopikTheme {
  return useContext(RichTopikThemeContext);
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
    (typeof props.payload === "string" ? `${props.payload}\n` : "");
  const payload =
    stringAttribute(props.payload) ?? (code.endsWith("\n") ? code.slice(0, -1) : code);
  const language = stringAttribute(props.language) ?? "text";
  const theme = useRichTopikTheme();
  const presented = Boolean(props.presentation);
  const [rendered, setRendered] = useState<{
    payload: string;
    language: string;
    theme: RichTopikTheme;
    presented: boolean;
    highlight: CodeHighlight;
  }>();

  useEffect(() => {
    let cancelled = false;
    // Large ordinary fences stay efficient plain text; avoid allocating Shiki rows at all.
    let rowCount = 1;
    for (let index = 0; index < payload.length; index++) {
      if (payload.charCodeAt(index) === 10 && ++rowCount > CODE_PRESENTATION_LIMITS.rows) return;
    }
    void import("shiki")
      .then(async (shiki) => {
        const highlight = await shiki.codeToTokens(payload, {
          lang: language,
          theme: shikiThemes[theme],
        });
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
        // Leave 512 units per row and 2048 per block for presentation markup.
        const escapedLength = escapedCodeLength(payload);
        const decorationBudget = Math.min(
          2048 + rows.length * 256 + payload.length * 6 - escapedLength,
          CONTENT_LIMITS.presentationOutputLength -
            escapedLength -
            2048 -
            (presented ? rows.length * 512 : 0),
        );
        if (decorationLength > decorationBudget) {
          throw new Error("Syntax highlighting exceeds the code decoration budget");
        }
        if (!cancelled) setRendered({ payload, language, theme, presented, highlight });
      })
      .catch(() => {
        console.warn("Failed to highlight code; using plain code");
      });
    return () => {
      cancelled = true;
    };
  }, [payload, language, theme, presented]);

  const highlight =
    rendered?.payload === payload &&
    rendered.language === language &&
    rendered.theme === theme &&
    rendered.presented === presented
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
    return katex.renderToString(content, { displayMode: true, throwOnError: false });
  }, [content]);

  if (!rendered.html) return <TopikMath {...props} />;
  return <div className="topik-rich-math" dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

export function RichTopikMathInline(props: TopikComponentProps) {
  const content = stringAttribute(props.content) ?? "";
  const rendered = useRenderedHtml(async () => {
    const katex = await import("katex");
    return katex.renderToString(content, { displayMode: false, throwOnError: false });
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
        const { default: mermaid } = await import("mermaid");
        const mermaidTheme = mermaidThemes[theme];
        if (initializedMermaidTheme !== mermaidTheme) {
          mermaid.initialize({
            securityLevel: "strict",
            startOnLoad: false,
            theme: mermaidTheme,
          });
          initializedMermaidTheme = mermaidTheme;
        }
        const result = await mermaid.render(`topik-mermaid-${id}`, content);
        return result.svg;
      }, minimumMermaidLoadingDurationMs),
    [content, id, theme],
  );

  if (rendered.status === "loading") {
    return (
      <div
        aria-label="Rendering diagram"
        aria-live="polite"
        className="topik-rich-mermaid topik-rich-mermaid--loading"
      />
    );
  }
  if (rendered.status === "error") return <TopikMermaid {...props} />;
  return <div className="topik-rich-mermaid" dangerouslySetInnerHTML={{ __html: rendered.html }} />;
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
  return useMemo(() => ({ ...richTopikComponents, ...overrides }), [overrides]);
}
