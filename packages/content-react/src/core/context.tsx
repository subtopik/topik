import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  getTopikComponents,
  type TopikAssetResolver,
  type TopikComponentMap,
  type TopikComponentOverrides,
  type TopikLinkHandler,
} from "./components";

const defaultTopikComponents = getTopikComponents();

export interface TopikContentContextValue {
  components: TopikComponentMap;
  componentOverrides?: TopikComponentOverrides;
  onNavigateLink?: TopikLinkHandler;
  resolveAsset?: TopikAssetResolver;
}

const TopikContentContext = createContext<TopikContentContextValue | undefined>(undefined);

export interface TopikContentProviderProps {
  children: ReactNode;
  components?: TopikComponentOverrides;
  onNavigateLink?: TopikLinkHandler;
  resolveAsset?: TopikAssetResolver;
}

export function TopikContentProvider({
  children,
  components,
  onNavigateLink,
  resolveAsset,
}: TopikContentProviderProps) {
  const value = useMemo(
    () => ({
      components: getTopikComponents(components),
      componentOverrides: components,
      onNavigateLink,
      resolveAsset,
    }),
    [components, onNavigateLink, resolveAsset],
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

export function useTopikContentContextValue(): TopikContentContextValue | undefined {
  return useContext(TopikContentContext);
}
