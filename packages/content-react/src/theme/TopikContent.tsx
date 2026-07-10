import { useMemo } from "react";
import { renderTopikMarkdown, type RenderTopikMarkdownOptions } from "../core/render";
import { useTopikContentContextValue } from "../core/context";
import { getDefaultTopikComponents } from "./components";
import type {
  TopikColorScheme,
  TopikLinkHandler,
  TopikLinkRenderer,
  TopikLinkResolver,
} from "../core/components";

export interface TopikContentProps extends RenderTopikMarkdownOptions {
  content: string;
  className?: string;
  colorScheme?: TopikColorScheme;
  onNavigateLink?: TopikLinkHandler;
  renderLink?: TopikLinkRenderer;
  resolveLink?: TopikLinkResolver;
}

export function TopikContent({
  className,
  colorScheme,
  components,
  content,
  onNavigateLink,
  renderLink,
  resolveAsset,
  resolveLink,
  ...compileOptions
}: TopikContentProps) {
  const context = useTopikContentContextValue();
  const effectiveColorScheme = colorScheme ?? context?.colorScheme;
  const effectiveOnNavigateLink = onNavigateLink ?? context?.onNavigateLink;
  const effectiveRenderLink = renderLink ?? context?.renderLink;
  const effectiveResolveLink = resolveLink ?? context?.resolveLink;
  const mergedComponents = useMemo(
    () =>
      getDefaultTopikComponents(
        {
          ...context?.componentOverrides,
          ...components,
        },
        {
          colorScheme: effectiveColorScheme,
          onNavigateLink: effectiveOnNavigateLink,
          renderLink: effectiveRenderLink,
          resolveLink: effectiveResolveLink,
        },
      ),
    [
      context?.componentOverrides,
      components,
      effectiveColorScheme,
      effectiveOnNavigateLink,
      effectiveRenderLink,
      effectiveResolveLink,
    ],
  );
  const effectiveResolveAsset = resolveAsset ?? context?.resolveAsset;
  const rendered = useMemo(
    () =>
      renderTopikMarkdown(content, {
        ...compileOptions,
        components: mergedComponents,
        resolveAsset: effectiveResolveAsset,
      }),
    [
      compileOptions.config,
      compileOptions.file,
      compileOptions.onDiagnostic,
      compileOptions.validate,
      content,
      effectiveResolveAsset,
      mergedComponents,
    ],
  );

  const classes = ["topik-content", className].filter(Boolean).join(" ");

  return <div className={classes}>{rendered}</div>;
}
