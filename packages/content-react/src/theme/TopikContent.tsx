import { useMemo } from "react";
import { renderTopikMarkdown, type RenderTopikMarkdownOptions } from "../core/render";
import { useTopikContentContextValue } from "../core/context";
import { getDefaultTopikComponents } from "./components";

export interface TopikContentProps extends RenderTopikMarkdownOptions {
  content: string;
  className?: string;
}

export function TopikContent({
  className,
  components,
  content,
  resolveAsset,
  ...compileOptions
}: TopikContentProps) {
  const context = useTopikContentContextValue();
  const mergedComponents = useMemo(
    () =>
      getDefaultTopikComponents({
        ...context?.componentOverrides,
        ...components,
      }),
    [context?.componentOverrides, components],
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
