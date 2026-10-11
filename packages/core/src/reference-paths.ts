import { posix } from "node:path";
import { validateTopikAssetReference, type TopikNavigationReference } from "@topik/content";
import { validateTopikPath } from "./assets/path";
import { isFolderHref } from "./folder-links";

/** Normalize source destinations identically during compilation and source transport. */
export function resolveSourceReferencePath(
  href: string,
  sourcePath: string,
  directory: string,
): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
  try {
    const path = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    const joined = path.startsWith("/")
      ? posix.join(directory, path.slice(1))
      : posix.join(posix.dirname(sourcePath), path || posix.basename(sourcePath));
    if (joined === "." && (isFolderHref(href) || path === "/") && !path.split("/").includes(".."))
      return "";
    const result = validateTopikPath(joined.endsWith("/") ? joined.slice(0, -1) : joined);
    return result.ok ? result.value.path : undefined;
  } catch {
    return undefined;
  }
}

/** A complete regular-file tree also proves every directory containing those files. */
export function sourcePathInventory(files: Iterable<string>): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of files) {
    let path = file;
    while (path !== "." && path !== "/") {
      paths.add(path);
      path = posix.dirname(path);
    }
  }
  return paths;
}

export function isSourceDirectory(path: string, paths: ReadonlySet<string>): boolean {
  return [...paths].some((entry) => entry.startsWith(path ? `${path}/` : ""));
}

export function isSourceFolderReference(
  href: string,
  sourcePath: string,
  directory: string,
  paths: ReadonlySet<string>,
): boolean {
  const path = resolveSourceReferencePath(href, sourcePath, directory);
  return path !== undefined && (isFolderHref(href) || isSourceDirectory(path, paths));
}

/** Existing non-Markdown files retain download semantics rather than page identity. */
export function isSourceNonPageReference(
  reference: Pick<TopikNavigationReference, "href" | "kind">,
  sourcePath: string,
  directory: string,
  paths: ReadonlySet<string>,
): boolean {
  const path = sourceNonMarkdownLinkPath(reference, sourcePath, directory);
  if (
    path === undefined ||
    !paths.has(path) ||
    isSourceDirectory(path, paths) ||
    isFolderHref(reference.href)
  )
    return false;
  // The compiler also preserves dotted non-Markdown paths with query/fragment suffixes.
  if (posix.extname(path) !== "") return true;
  const asset = validateTopikAssetReference(reference.href);
  return asset.valid && asset.kind === "local";
}

/** Identify a local non-Markdown file spelling before consulting the path inventory. */
export function sourceNonMarkdownLinkPath(
  reference: Pick<TopikNavigationReference, "href" | "kind">,
  sourcePath: string,
  directory: string,
): string | undefined {
  if (reference.kind !== "link") return undefined;
  const path = resolveSourceReferencePath(reference.href, sourcePath, directory);
  return path !== undefined && !/\.(?:mdx?|markdown)$/i.test(path) ? path : undefined;
}
