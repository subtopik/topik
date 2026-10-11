/** Folder shorthand selects declared content, never an arbitrary directory listing. */
export function folderLandingCandidates<T>(directory: string, pages: ReadonlyMap<string, T>): T[] {
  const prefix = directory ? `${directory}/` : "";
  return [...pages]
    .filter(
      ([path]) => path.startsWith(prefix) && /^(?:index|readme)$/i.test(path.slice(prefix.length)),
    )
    .map(([, page]) => page);
}

export function hasDeclaredFolder<T>(directory: string, pages: ReadonlyMap<string, T>): boolean {
  const prefix = directory ? `${directory}/` : "";
  return [...pages.keys()].some((path) => path.startsWith(prefix));
}

/** Explicit Markdown filenames retain their historical trailing-separator spelling. */
export function isFolderHref(href: string): boolean {
  try {
    const path = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    if (path === "/") return false;
    return (
      !/\.(?:mdx?|markdown)\/*$/i.test(path) &&
      (path.endsWith("/") || /(?:^|\/)\.{1,2}$/.test(path))
    );
  } catch {
    return false;
  }
}

export function resolveDeclaredSourcePage<T>(
  path: string,
  pages: ReadonlyMap<string, T>,
  folder = false,
): T | undefined {
  if (!folder && !hasDeclaredFolder(path, pages)) return pages.get(path);
  const candidates = folderLandingCandidates(path, pages);
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function isPublicRouteHref(href: string, route: string | undefined): boolean {
  if (route === undefined || !href.startsWith("/") || href.startsWith("//") || isFolderHref(href))
    return false;
  try {
    return (
      decodeURIComponent(new URL(href, "https://topik.invalid").pathname).replace(
        /^\/+|\/+$/g,
        "",
      ) === route
    );
  } catch {
    return false;
  }
}
