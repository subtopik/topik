import { posix } from "node:path";
import { validateTopikAssetReference, type TopikNavigationReference } from "@topik/content";
import { validateTopikPath } from "./assets/path";
import { isFolderHref, resolveNavigationPath } from "./folder-links";

/** Physical source paths also satisfy the portable filesystem contract. */
export function resolveSourceReferencePath(
  href: string,
  sourcePath: string,
  directory: string,
): string | undefined {
  const path = resolveNavigationPath(href, sourcePath, directory);
  if (path === undefined || path === "") return path;
  const result = validateTopikPath(path);
  return result.ok ? result.value.path : undefined;
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
