import type { ReactNode } from "react";
import { TopikContentProvider, type TopikContentProviderProps } from "./core/context";
import type { TopikComponentMap } from "./core/components";
import {
  richTopikComponents,
  RichTopikCodeBlock,
  RichTopikMath,
  RichTopikMathInline,
  RichTopikMermaid,
  useRichTopikComponents,
} from "./rich/components";
import { getDefaultTopikComponents } from "./theme/components";

export interface RichTopikContentProviderProps extends Omit<
  TopikContentProviderProps,
  "components" | "children"
> {
  children: ReactNode;
  components?: Partial<TopikComponentMap>;
}

export function getRichTopikComponents(
  overrides: Partial<TopikComponentMap> = {},
): TopikComponentMap {
  return getDefaultTopikComponents({ ...richTopikComponents, ...overrides });
}

export function RichTopikContentProvider({
  children,
  components,
  ...props
}: RichTopikContentProviderProps) {
  const mergedComponents = useRichTopikComponents(components);
  return (
    <TopikContentProvider {...props} components={mergedComponents}>
      {children}
    </TopikContentProvider>
  );
}

export {
  richTopikComponents,
  RichTopikCodeBlock,
  RichTopikMath,
  RichTopikMathInline,
  RichTopikMermaid,
  useRichTopikComponents,
};
