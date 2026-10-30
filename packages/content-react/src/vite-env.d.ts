declare module "*.css";

declare module "katex" {
  export function renderToString(
    content: string,
    options?: {
      displayMode?: boolean;
      throwOnError?: boolean;
      output?: "html" | "mathml" | "htmlAndMathml";
      trust?: boolean;
      strict?: "error";
      maxExpand?: number;
      maxSize?: number;
      macros?: Record<string, string>;
    },
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
