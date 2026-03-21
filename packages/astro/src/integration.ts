import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { AstroIntegration } from "astro";

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

          for (const dir of resolvedDirs) {
            // Try to serve the asset from each content directory.
            // Assets are referenced relative to their content dir,
            // e.g. /images/screenshot.png -> <dir>/images/screenshot.png
            const filePath = join(dir, url.pathname);
            const normalized = resolve(filePath);

            // Prevent directory traversal
            if (!normalized.startsWith(dir)) continue;

            if (existsSync(normalized)) {
              readFile(normalized)
                .then((data) => {
                  res.setHeader("Content-Type", mimeType(ext));
                  res.end(data);
                })
                .catch(() => next());
              return;
            }
          }

          next();
        });
      },
    },
  };
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
