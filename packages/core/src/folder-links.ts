/** Resolve decoded source paths consistently without URL root-clamping or Node-only APIs. */
export function resolveNavigationPath(
  href: string,
  sourcePath: string,
  directory = "",
): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
  try {
    const path = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    const base = path.startsWith("/") ? directory : sourcePath.split("/").slice(0, -1).join("/");
    const relative = path.startsWith("/") ? path.slice(1) : path || sourcePath.split("/").at(-1)!;
    const parts: string[] = [];
    for (const part of `${base}/${relative}`.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return undefined;
        parts.pop();
      } else parts.push(part);
    }
    if (!parts.length && (isFolderHref(href) || path === "/")) return "";
    return parts.length ? parts.join("/") : undefined;
  } catch {
    return undefined;
  }
}

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

/** Wiki's index aliases are public routes in every consumer, including compilation. */
export function resolveDeclaredPublicRoute<T>(
  href: string,
  pages: ReadonlyMap<string, T>,
  wiki = false,
): T | undefined {
  if (!href.startsWith("/") || isFolderHref(href)) return undefined;
  const path = resolveNavigationPath(href, "");
  if (path === undefined || /\.(?:mdx?|markdown)$/i.test(path)) return undefined;
  const route = wiki ? (path === "index" ? "" : path.replace(/\/index$/, "")) : path;
  return pages.get(route);
}
