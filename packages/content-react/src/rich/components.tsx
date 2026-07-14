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
import { TopikCodeBlock, TopikMath, TopikMathInline, TopikMermaid } from "../theme/components";
import type { TopikComponentMap, TopikComponentProps } from "../core/components";

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

  useEffect(() => {
    let cancelled = false;
    setState({ html: "", status: "loading" });
    void load()
      .then((html) => {
        if (!cancelled) setState({ html, status: "rendered" });
      })
      .catch(() => {
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
  const code = stringAttribute(props.content) ?? "";
  const language = stringAttribute(props.language) ?? "text";
  const theme = useRichTopikTheme();
  const [copied, setCopied] = useState(false);
  const rendered = useRenderedHtml(async () => {
    const shiki = await import("shiki");
    return shiki.codeToHtml(code, { lang: language, theme: shikiThemes[theme] });
  }, [code, language, theme]);

  async function copyCode() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="topik-rich-code-block">
      <div className="topik-rich-code-block__frame">
        {rendered.html ? (
          <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
        ) : (
          <TopikCodeBlock {...props} />
        )}
        <button
          className="topik-rich-code-block__copy"
          onClick={() => void copyCode()}
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
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
