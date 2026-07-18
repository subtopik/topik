import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AstroIntegration } from "astro";

const SAFE_READ_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
  (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);

export interface TopikOptions {
  /** Directories containing topik content (guides, wikis). */
  dirs: string[];
}

const ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
  ".mp4",
  ".webm",
]);

export function topik(options: TopikOptions): AstroIntegration {
  const resolvedDirs = options.dirs.map((d) => resolve(d));

  return {
    name: "@topik/astro",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use((req, res, next) => {
          if (!req.url) return next();

          const url = new URL(req.url, "http://localhost");
          const ext = extname(url.pathname);
          if (!ASSET_EXTENSIONS.has(ext)) return next();

          void readAsset(resolvedDirs, url.pathname)
            .then((data) => {
              if (data === undefined) {
                next();
                return;
              }

              res.setHeader("Content-Type", mimeType(ext));
              res.end(data);
            })
            .catch(() => next());
        });
      },
    },
  };
}

async function readAsset(dirs: string[], urlPath: string): Promise<Buffer | undefined> {
  for (const dir of dirs) {
    // Assets are referenced relative to their content dir,
    // e.g. /images/screenshot.png -> <dir>/images/screenshot.png
    const filePath = resolve(join(dir, urlPath));

    // Reject lexical traversal before resolving any symlinks.
    if (!isWithin(dir, filePath)) continue;

    try {
      const [canonicalDir, canonicalFile] = await Promise.all([realpath(dir), realpath(filePath)]);
      if (!isWithin(canonicalDir, canonicalFile)) continue;

      // Verify and read through one handle; O_NOFOLLOW additionally hardens the
      // final component on platforms that expose it.
      const file = await open(canonicalFile, SAFE_READ_FLAGS);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) continue;
        return await file.readFile();
      } finally {
        await file.close();
      }
    } catch {
      // Try the next configured content directory.
    }
  }

  return undefined;
}

function isWithin(dir: string, filePath: string): boolean {
  const pathFromDir = relative(dir, filePath);
  return (
    pathFromDir === "" ||
    (pathFromDir !== ".." && !pathFromDir.startsWith(`..${sep}`) && !isAbsolute(pathFromDir))
  );
}

function mimeType(ext: string): string {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  };
  return types[ext] ?? "application/octet-stream";
}
