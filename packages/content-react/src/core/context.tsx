"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  getTopikComponents,
  type TopikAssetResolver,
  type TopikColorScheme,
  type TopikComponentMap,
  type TopikComponentOverrides,
  type TopikLinkHandler,
  type TopikLinkRenderer,
  type TopikLinkResolver,
} from "./components";

const defaultTopikComponents = getTopikComponents();

export interface TopikContentContextValue {
  colorScheme?: TopikColorScheme;
  components: TopikComponentMap;
  componentOverrides?: TopikComponentOverrides;
  onNavigateLink?: TopikLinkHandler;
  resolveAsset?: TopikAssetResolver;
  resolveLink?: TopikLinkResolver;
  renderLink?: TopikLinkRenderer;
}

const TopikContentContext = createContext<TopikContentContextValue | undefined>(undefined);

export interface TopikContentProviderProps {
  children: ReactNode;
  colorScheme?: TopikColorScheme;
  components?: TopikComponentOverrides;
  onNavigateLink?: TopikLinkHandler;
  resolveAsset?: TopikAssetResolver;
  resolveLink?: TopikLinkResolver;
  renderLink?: TopikLinkRenderer;
}

export function TopikContentProvider({
  children,
  colorScheme,
  components,
  onNavigateLink,
  resolveAsset,
  resolveLink,
  renderLink,
}: TopikContentProviderProps) {
  const value = useMemo(
    () => ({
      colorScheme,
      components: getTopikComponents(components),
      componentOverrides: components,
      onNavigateLink,
      resolveAsset,
      resolveLink,
      renderLink,
    }),
    [colorScheme, components, onNavigateLink, renderLink, resolveAsset, resolveLink],
  );

  return <TopikContentContext.Provider value={value}>{children}</TopikContentContext.Provider>;
}

export function useTopikComponents(): TopikComponentMap {
  return useContext(TopikContentContext)?.components ?? defaultTopikComponents;
}

export function useTopikAssetResolver(): TopikAssetResolver | undefined {
  return useContext(TopikContentContext)?.resolveAsset;
}

export function useTopikLinkHandler(): TopikLinkHandler | undefined {
  return useContext(TopikContentContext)?.onNavigateLink;
}

export function useTopikLinkResolver(): TopikLinkResolver | undefined {
  return useContext(TopikContentContext)?.resolveLink;
}

export function useTopikLinkRenderer(): TopikLinkRenderer | undefined {
  return useContext(TopikContentContext)?.renderLink;
}

export function useTopikContentContextValue(): TopikContentContextValue | undefined {
  return useContext(TopikContentContext);
}

const TopikRenderedColorSchemeContext = createContext<TopikColorScheme | undefined>(undefined);

/** @internal The scheme a `TopikContent` root renders with, for components inside that root. */
export const TopikRenderedColorSchemeProvider = TopikRenderedColorSchemeContext.Provider;

/** @internal The enclosing content root's scheme, else the provider's, else undefined. */
export function useTopikColorScheme(): TopikColorScheme | undefined {
  const rendered = useContext(TopikRenderedColorSchemeContext);
  const provided = useContext(TopikContentContext)?.colorScheme;
  return rendered ?? provided;
}
