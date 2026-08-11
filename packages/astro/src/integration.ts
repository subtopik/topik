import type { AstroIntegration } from "astro";
import { assertTopikAssetLoaders, findTopikAssetPayload, type TopikAssetLoader } from "./assets";

export type { TopikAssetLoader } from "./assets";

export interface TopikOptions {
  /** Topik Guide/Wiki loaders whose current compiler snapshots may be delivered. */
  loaders: readonly TopikAssetLoader[];
}

const PAYLOAD_PATH_PATTERN = /^\/assets\/sha256\/[0-9a-f]{64}$/u;

export function topik(options: TopikOptions): AstroIntegration {
  assertTopikAssetLoaders(options.loaders);
  const loaders = [...options.loaders];

  return {
    name: "@topik/astro",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use((req, res, next) => {
          if (req.method !== "GET" && req.method !== "HEAD") return next();
          if (req.url === undefined) return next();

          let pathname: string;
          try {
            pathname = new URL(req.url, "http://localhost").pathname;
          } catch {
            return next();
          }
          if (!PAYLOAD_PATH_PATTERN.test(pathname)) return next();

          const payload = findTopikAssetPayload(loaders, pathname.slice(1));
          if (payload === undefined) return next();
          res.setHeader("Content-Type", payload.mediaType);
          res.setHeader("Content-Length", String(payload.size));
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.end(req.method === "HEAD" ? undefined : Buffer.from(payload.bytes));
        });
      },
    },
  };
}
