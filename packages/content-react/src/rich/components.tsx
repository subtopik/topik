import { useEffect, useId, useMemo, useRef, useState, type DependencyList } from "react";
import { TopikCodeBlock, TopikMath, TopikMathInline, TopikMermaid } from "../theme/components";
import type { TopikComponentMap, TopikComponentProps } from "../core/components";

interface HtmlState {
  html: string;
}

const emptyTopikComponents: Partial<TopikComponentMap> = {};

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function useRenderedHtml(load: () => Promise<string>, deps: DependencyList): HtmlState {
  const [state, setState] = useState<HtmlState>({ html: "" });

  useEffect(() => {
    let cancelled = false;
    setState({ html: "" });
    void load()
      .then((html) => {
        if (!cancelled) setState({ html });
      })
      .catch(() => {
        if (!cancelled) setState({ html: "" });
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
  const [copied, setCopied] = useState(false);
  const rendered = useRenderedHtml(async () => {
    const shiki = await import(/* @vite-ignore */ "shiki");
    return shiki.codeToHtml(code, { lang: language, theme: "github-dark" });
  }, [code, language]);

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
    const katex = await import(/* @vite-ignore */ "katex");
    return katex.renderToString(content, { displayMode: true, throwOnError: false });
  }, [content]);

  if (!rendered.html) return <TopikMath {...props} />;
  return <div className="topik-rich-math" dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

export function RichTopikMathInline(props: TopikComponentProps) {
  const content = stringAttribute(props.content) ?? "";
  const rendered = useRenderedHtml(async () => {
    const katex = await import(/* @vite-ignore */ "katex");
    return katex.renderToString(content, { displayMode: false, throwOnError: false });
  }, [content]);

  if (!rendered.html) return <TopikMathInline {...props} />;
  return (
    <span className="topik-rich-math-inline" dangerouslySetInnerHTML={{ __html: rendered.html }} />
  );
}

export function RichTopikMermaid(props: TopikComponentProps) {
  const content = stringAttribute(props.content) ?? "";
  const id = useId().replace(/:/g, "-");
  const initialized = useRef(false);
  const rendered = useRenderedHtml(async () => {
    const { default: mermaid } = await import(/* @vite-ignore */ "mermaid");
    if (!initialized.current) {
      mermaid.initialize({ securityLevel: "strict", startOnLoad: false, theme: "default" });
      initialized.current = true;
    }
    const result = await mermaid.render(`topik-mermaid-${id}`, content);
    return result.svg;
  }, [content, id]);

  if (!rendered.html) return <TopikMermaid {...props} />;
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
