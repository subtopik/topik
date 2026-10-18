declare module "*.css";

declare module "katex" {
  export function renderToString(
    content: string,
    options?: { displayMode?: boolean; throwOnError?: boolean },
  ): string;
}

declare module "shiki" {
  export function codeToTokens(
    code: string,
    options: { lang: string; theme: string },
  ): Promise<{
    tokens: { content: string; color?: string; fontStyle?: number }[][];
    fg?: string;
    bg?: string;
  }>;
  export function codeToHtml(
    code: string,
    options: { lang: string; theme: string },
  ): Promise<string>;
}
