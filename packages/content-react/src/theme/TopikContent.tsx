import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TopikContentDiagnostic } from "@topik/content";
import {
  compileTopikContent,
  InvalidTopikContentError,
  renderTopikContent,
  type CompileTopikContentFailure,
  type CompileTopikContentResult,
  type RenderTopikMarkdownOptions,
  type TopikAssetResolutionDiagnostic,
  type TopikLinkResolutionDiagnostic,
  type TopikNavigationResolutionDiagnostic,
} from "../core/render";
import { TopikRenderedColorSchemeProvider, useTopikContentContextValue } from "../core/context";
import { getDefaultTopikComponents, TopikSlotOptionsProvider } from "./components";
import {
  mergeTopikComponentOverrides,
  type TopikColorScheme,
  type TopikAssetResolver,
  type TopikComponentOverrides,
  type TopikLinkHandler,
  type TopikLinkRenderer,
  type TopikLinkResolver,
} from "../core/components";

export interface TopikContentProps extends RenderTopikMarkdownOptions {
  content: string;
  className?: string;
  colorScheme?: TopikColorScheme;
  onNavigateLink?: TopikLinkHandler;
  renderLink?: TopikLinkRenderer;
  resolveLink?: TopikLinkResolver;
  resolveAsset?: TopikAssetResolver;
}

interface RenderedTopikContent {
  compiled: CompileTopikContentResult;
  node: ReactNode;
  assetDiagnostics: TopikAssetResolutionDiagnostic[];
  linkDiagnostics: TopikLinkResolutionDiagnostic[];
  navigationDiagnostics: TopikNavigationResolutionDiagnostic[];
}

interface TopikContentDiagnosticHandlers {
  onAssetDiagnostic?: (diagnostic: TopikAssetResolutionDiagnostic) => void;
  onDiagnostic?: (diagnostic: TopikContentDiagnostic) => void;
  onLinkDiagnostic?: (diagnostic: TopikLinkResolutionDiagnostic) => void;
  onNavigationDiagnostic?: (diagnostic: TopikNavigationResolutionDiagnostic) => void;
}

// Without a DOM no commit follows, so server rendering reports while rendering.
const canUseDOM = typeof document !== "undefined";

const subscribeNever = () => () => {};
const clientSnapshot = () => false;
const serverSnapshot = () => true;

/** True while React renders on a server (or hydrates), where no layout effect may follow. */
function useServerRender(): boolean {
  return useSyncExternalStore(subscribeNever, clientSnapshot, serverSnapshot);
}

/** Compile-time guard: every TopikContentProps field must be destructured explicitly below. */
function assertHandledProps(_rest: Record<string, never>): void {}

export function TopikContent(props: TopikContentProps) {
  const {
    className,
    colorScheme,
    components,
    config,
    content,
    file,
    invalidContent,
    invalidContentPlaceholder,
    onAssetDiagnostic,
    onDiagnostic,
    onLinkDiagnostic,
    onNavigateLink,
    onNavigationDiagnostic,
    previewAssets,
    renderLink,
    resolveAsset,
    resolveLink,
    ...rest
  } = props;
  assertHandledProps(rest);
  const handlers: TopikContentDiagnosticHandlers = {
    onAssetDiagnostic,
    onDiagnostic,
    onLinkDiagnostic,
    onNavigationDiagnostic,
  };

  const context = useTopikContentContextValue();
  const effectiveColorScheme = colorScheme ?? context?.colorScheme;
  const effectiveOnNavigateLink = onNavigateLink ?? context?.onNavigateLink;
  const effectiveRenderLink = renderLink ?? context?.renderLink;
  const effectiveResolveLink = resolveLink ?? context?.resolveLink;
  const effectiveResolveAsset = resolveAsset ?? context?.resolveAsset;

  // Only these inputs affect compilation; inline but equal config objects reuse the result.
  const stableConfig = useStableValue(config, plainDataEqual);
  const compiled = useMemo(
    () => compileTopikContent(content, { config: stableConfig, file }),
    [content, file, stableConfig],
  );

  const overrides = useStableValue<TopikComponentOverrides>(
    mergeTopikComponentOverrides(context?.componentOverrides, components),
    shallowEqual,
  );
  const mergedComponents = useMemo(() => getDefaultTopikComponents(overrides), [overrides]);
  // Slots read link and figure options from context, so new handlers never remount content.
  const slotOptions = useMemo(
    () => ({
      colorScheme: effectiveColorScheme,
      onNavigateLink: effectiveOnNavigateLink,
      renderLink: effectiveRenderLink,
      resolveLink: effectiveResolveLink,
    }),
    [effectiveColorScheme, effectiveOnNavigateLink, effectiveRenderLink, effectiveResolveLink],
  );

  const throwsInvalid = !compiled.ok && invalidContent !== "placeholder";
  // On the client, invalid content first commits an empty root and reports from a layout effect;
  // the following render throws. React may retry a throwing render, so it reports nothing itself.
  const serverRender = useServerRender();
  const [thrown, setThrown] = useState<CompileTopikContentResult>();
  if (throwsInvalid && (serverRender || thrown === compiled)) {
    // No commit follows a server render, so it reports before throwing.
    if (serverRender) reportCompileDiagnostics(compiled, handlers);
    throw new InvalidTopikContentError(compiled as CompileTopikContentFailure);
  }

  const rendered = useMemo((): RenderedTopikContent => {
    const result: RenderedTopikContent = {
      compiled,
      node: null,
      assetDiagnostics: [],
      linkDiagnostics: [],
      navigationDiagnostics: [],
    };
    if (throwsInvalid) return result;
    result.node = renderTopikContent(compiled, {
      components: mergedComponents,
      invalidContent,
      invalidContentPlaceholder,
      previewAssets,
      resolveAsset: effectiveResolveAsset,
      resolveLink: effectiveResolveLink,
      onAssetDiagnostic: (diagnostic) => result.assetDiagnostics.push(diagnostic),
      onLinkDiagnostic: (diagnostic) => result.linkDiagnostics.push(diagnostic),
      onNavigationDiagnostic: (diagnostic) => result.navigationDiagnostics.push(diagnostic),
    });
    return result;
  }, [
    compiled,
    throwsInvalid,
    effectiveResolveAsset,
    effectiveResolveLink,
    invalidContent,
    invalidContentPlaceholder,
    mergedComponents,
    previewAssets,
  ]);

  if (!canUseDOM) reportDiagnostics(rendered, undefined, handlers);

  // Report after commit with the latest callbacks, once per distinct result.
  const reported = useRef<RenderedTopikContent | undefined>(undefined);
  useLayoutEffect(() => {
    if (!throwsInvalid || reported.current === rendered) return;
    reported.current = rendered;
    reportCompileDiagnostics(rendered.compiled, handlers);
    setThrown(rendered.compiled);
  });
  useEffect(() => {
    const previous = reported.current;
    if (previous === rendered) return;
    reported.current = rendered;
    reportDiagnostics(rendered, previous, handlers);
  });

  const classes = ["topik-content", className].filter(Boolean).join(" ");

  return (
    <div className={classes} data-theme={effectiveColorScheme}>
      <TopikRenderedColorSchemeProvider value={effectiveColorScheme}>
        <TopikSlotOptionsProvider value={slotOptions}>{rendered.node}</TopikSlotOptionsProvider>
      </TopikRenderedColorSchemeProvider>
    </div>
  );
}

function reportCompileDiagnostics(
  compiled: CompileTopikContentResult,
  handlers: TopikContentDiagnosticHandlers,
): void {
  if (!compiled.ok)
    for (const diagnostic of compiled.diagnostics) handlers.onDiagnostic?.(diagnostic);
}

function reportDiagnostics(
  rendered: RenderedTopikContent,
  previous: RenderedTopikContent | undefined,
  handlers: TopikContentDiagnosticHandlers,
): void {
  const recompiled = previous?.compiled !== rendered.compiled;
  if (recompiled) reportCompileDiagnostics(rendered.compiled, handlers);
  // Re-resolving the same document (for example with an inline resolver) reports only changes.
  const report = <T,>(
    current: T[],
    before: T[] | undefined,
    handler: ((diagnostic: T) => void) | undefined,
  ) => {
    if (!recompiled && before !== undefined && plainDataEqual(current, before)) return;
    for (const diagnostic of current) handler?.(diagnostic);
  };
  report(rendered.assetDiagnostics, previous?.assetDiagnostics, handlers.onAssetDiagnostic);
  report(rendered.linkDiagnostics, previous?.linkDiagnostics, handlers.onLinkDiagnostic);
  report(
    rendered.navigationDiagnostics,
    previous?.navigationDiagnostics,
    handlers.onNavigationDiagnostic,
  );
}

/** Keep the previous value while it is equal, so memoised work keys on meaning, not identity. */
function useStableValue<T>(value: T, equal: (left: T, right: T) => boolean): T {
  const [stable, setStable] = useState(value);
  if (stable === value || equal(stable, value)) return stable;
  setStable(value);
  return value;
}

function shallowEqual<T extends object>(left: T, right: T): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && Object.is(left[key as keyof T], right[key as keyof T]),
  );
}

/** Structural equality for JSON-like data; any other object compares by identity. */
function plainDataEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > 64 || typeof left !== "object" || typeof right !== "object") return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => plainDataEqual(entry, right[index], depth + 1))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && plainDataEqual(left[key], right[key], depth + 1),
  );
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
