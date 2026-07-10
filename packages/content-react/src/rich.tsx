"use client";

import type { ReactNode } from "react";
import { TopikContentProvider, type TopikContentProviderProps } from "./core/context";
import type { TopikComponentMap } from "./core/components";
import {
  richTopikComponents,
  RichTopikCodeBlock,
  RichTopikMath,
  RichTopikMathInline,
  RichTopikMermaid,
  RichTopikThemeProvider,
  type RichTopikTheme,
  useRichTopikComponents,
} from "./rich/components";
import { getDefaultTopikComponents } from "./theme/components";

export interface RichTopikContentProviderProps extends Omit<
  TopikContentProviderProps,
  "components" | "children"
> {
  children: ReactNode;
  components?: Partial<TopikComponentMap>;
  theme?: RichTopikTheme;
}

export function getRichTopikComponents(
  overrides: Partial<TopikComponentMap> = {},
): TopikComponentMap {
  return getDefaultTopikComponents({ ...richTopikComponents, ...overrides });
}

export function RichTopikContentProvider({
  children,
  components,
  theme,
  ...props
}: RichTopikContentProviderProps) {
  const mergedComponents = useRichTopikComponents(components);
  return (
    <RichTopikThemeProvider theme={theme}>
      <TopikContentProvider {...props} components={mergedComponents}>
        {children}
      </TopikContentProvider>
    </RichTopikThemeProvider>
  );
}

export {
  richTopikComponents,
  RichTopikCodeBlock,
  RichTopikMath,
  RichTopikMathInline,
  RichTopikMermaid,
  RichTopikThemeProvider,
  useRichTopikComponents,
  type RichTopikTheme,
};
