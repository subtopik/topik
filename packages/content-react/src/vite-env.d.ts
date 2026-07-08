declare module "*.css";

declare module "katex" {
  export function renderToString(
    content: string,
    options?: { displayMode?: boolean; throwOnError?: boolean },
  ): string;
}

declare module "mermaid" {
  const mermaid: {
    initialize(options: Record<string, unknown>): void;
    render(id: string, content: string): Promise<{ svg: string }>;
  };
  export default mermaid;
}

declare module "shiki" {
  export function codeToHtml(
    code: string,
    options: { lang: string; theme: string },
  ): Promise<string>;
}
