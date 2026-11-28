import { writeFile } from "node:fs/promises";
import type { AstroIntegration } from "astro";
import {
  isTopikDownloadOnlyMediaType,
  parseTopikByteRange,
  usesPortableFileReads,
} from "@topik/core";
import {
  assertTopikAssetLoaders,
  collectTopikAssetPayloads,
  collectTopikAssetUrls,
  findTopikAssetPayload,
  refreshTopikAssetSnapshots,
  setTopikAssetBase,
  type TopikAssetLoader,
} from "./assets";
import { publishDigestSnapshot, removeDigestSnapshot } from "./publication";

export type { TopikAssetLoader } from "./assets";

export interface TopikOptions {
  /** Topik Guide/Wiki loaders whose complete compiler snapshot is delivered. */
  loaders: readonly TopikAssetLoader[];
}

const PAYLOAD_PATH_PATTERN = /^\/blobs\/[0-9a-f]{64}$/u;
const PAYLOAD_RELATIVE_PATTERN = /^blobs\/[0-9a-f]{64}$/u;
/** Development snapshots change between compilations; revalidate every request. */
const DEVELOPMENT_CACHE_CONTROL = "no-cache";
/** Production blob paths are content-addressed (`blobs/<sha256>`), so bytes never change. */
const PRODUCTION_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Mirrors the CLI notice: announced once per build when the weaker portable mode is used. */
export const PORTABLE_PUBLICATION_NOTICE =
  "This platform cannot anchor file access to the output directory, so Topik checks paths and file identity when it writes blobs/. Build only in a workspace you trust.";
const VIRTUAL_SNAPSHOT_ID = "virtual:@topik/astro/asset-snapshot";
const RESOLVED_VIRTUAL_SNAPSHOT_ID = `\0${VIRTUAL_SNAPSHOT_ID}`;

export function topik(options: TopikOptions): AstroIntegration {
  assertTopikAssetLoaders(options.loaders);
  const loaders = [...options.loaders];
  let base = "/";

  return {
    name: "@topik/astro",
    hooks: {
      "astro:config:setup": async ({
        addMiddleware,
        command,
        config,
        createCodegenDir,
        logger,
        updateConfig,
      }) => {
        const trimmedBase = (config.base ?? "/").replace(/^\/+|\/+$/gu, "");
        base = trimmedBase ? `/${trimmedBase}/` : "/";
        setTopikAssetBase(loaders, base);
        if (command === "build") {
          if (usesPortableFileReads()) logger.warn(PORTABLE_PUBLICATION_NOTICE);
          await removePublishedSnapshot(
            config.output === "server" ? config.build.client : config.outDir,
          );
          const codegenDir = createCodegenDir();
          const middleware = new URL("topik-asset-middleware.mjs", codegenDir);
          await writeFile(middleware, productionMiddlewareSource(base), { encoding: "utf8" });
          addMiddleware({ entrypoint: middleware, order: "pre" });
          updateConfig({ vite: { plugins: [snapshotPlugin(loaders, base)] } });
        }
      },
      "astro:build:start": async () => {
        await refreshTopikAssetSnapshots(loaders);
      },
      "astro:build:done": async ({ dir }) => {
        await publishStaticSnapshot(loaders, dir);
      },
      "astro:server:setup": ({ server }) => {
        server.middlewares.use((req, res, next) => {
          if (req.method !== "GET" && req.method !== "HEAD") return next();
          const rawTarget = (req as typeof req & { originalUrl?: string }).originalUrl ?? req.url;
          if (rawTarget === undefined) return next();
          const queryOffset = rawTarget.indexOf("?");
          const requestPath = queryOffset === -1 ? rawTarget : rawTarget.slice(0, queryOffset);
          if (!requestPath.startsWith(base)) return next();
          const pathname = `/${requestPath.slice(base.length)}`;
          if (!PAYLOAD_PATH_PATTERN.test(pathname)) return next();

          const payload = findTopikAssetPayload(loaders, pathname.slice(1));
          if (payload === undefined) return next();
          for (const [name, value] of Object.entries(
            assetHeaders(payload.mediaType, payload.size, DEVELOPMENT_CACHE_CONTROL),
          )) {
            res.setHeader(name, value);
          }
          // Ranges apply to GET only; payloads carry no validator, so If-Range never matches.
          const range =
            req.method === "GET" && req.headers["if-range"] === undefined
              ? parseTopikByteRange(req.headers.range, payload.size)
              : undefined;
          if (range === "unsatisfiable") {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${payload.size}`);
            res.removeHeader("Content-Length");
            res.end();
            return;
          }
          if (range !== undefined) {
            res.statusCode = 206;
            res.setHeader("Content-Length", String(range.end - range.start + 1));
            res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${payload.size}`);
            res.end(Buffer.from(payload.bytes.subarray(range.start, range.end + 1)));
            return;
          }
          res.end(req.method === "HEAD" ? undefined : Buffer.from(payload.bytes));
        });
      },
    },
  };
}

function assetHeaders(mediaType: string, size: number, cacheControl: string) {
  return {
    "Cache-Control": cacheControl,
    "Content-Length": String(size),
    "Content-Type": mediaType,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    ...(isTopikDownloadOnlyMediaType(mediaType) ? { "Content-Disposition": "attachment" } : {}),
  };
}

function snapshotPlugin(loaders: readonly TopikAssetLoader[], base: string) {
  return {
    name: "@topik/astro:asset-snapshot",
    resolveId(id: string) {
      return id === VIRTUAL_SNAPSHOT_ID ? RESOLVED_VIRTUAL_SNAPSHOT_ID : undefined;
    },
    load(id: string) {
      if (id !== RESOLVED_VIRTUAL_SNAPSHOT_ID) return undefined;
      const records = collectTopikAssetPayloads(loaders).map((payload) => [
        `${base}${payload.path}`,
        payload.mediaType,
        payload.size,
        Buffer.from(payload.bytes).toString("base64"),
        // Decided at build time with core's rule; the middleware does not import core.
        isTopikDownloadOnlyMediaType(payload.mediaType),
      ]);
      const urls = [...collectTopikAssetUrls(loaders)];
      return `const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));\nexport const topikAssetPayloads = new Map(${JSON.stringify(records)}.map(([path, mediaType, size, bytes, attachment]) => [path, { bytes: decode(bytes), mediaType, size, attachment }]));\nexport const topikAssetUrls = new Map(${JSON.stringify(urls)});\n`;
    },
  };
}

function productionMiddlewareSource(base: string): string {
  return `import { topikAssetPayloads, topikAssetUrls } from ${JSON.stringify(VIRTUAL_SNAPSHOT_ID)};
globalThis[Symbol.for("@topik/astro/runtime-asset-urls")] = topikAssetUrls;
const pattern = /^\\/blobs\\/[0-9a-f]{64}$/u;
// The same parser as topik dev, embedded because this module does not import core.
const parseByteRange = ${parseTopikByteRange.toString()};
export async function onRequest(context, next) {
  const request = context.request;
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  const pathname = new URL(request.url).pathname;
  const base = ${JSON.stringify(base)};
  if (!pathname.startsWith(base) || !pattern.test("/" + pathname.slice(base.length))) return next();
  const payload = topikAssetPayloads.get(pathname);
  if (payload === undefined) return next();
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": ${JSON.stringify(PRODUCTION_CACHE_CONTROL)},
    "Content-Type": payload.mediaType,
    "X-Content-Type-Options": "nosniff",
    ...(payload.attachment ? { "Content-Disposition": "attachment" } : {}),
  };
  // Ranges apply to GET only; payloads carry no validator, so If-Range never matches.
  const range =
    request.method === "GET" && !request.headers.has("if-range")
      ? parseByteRange(request.headers.get("range") ?? undefined, payload.size)
      : undefined;
  if (range === "unsatisfiable")
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": "bytes */" + payload.size } });
  if (range !== undefined)
    return new Response(payload.bytes.subarray(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": "bytes " + range.start + "-" + range.end + "/" + payload.size,
      },
    });
  return new Response(request.method === "HEAD" ? null : payload.bytes, {
    headers: { ...headers, "Content-Length": String(payload.size) },
  });
}
`;
}

async function publishStaticSnapshot(
  loaders: readonly TopikAssetLoader[],
  outputDirectory: URL,
): Promise<void> {
  const payloads = collectTopikAssetPayloads(loaders);
  await publishDigestSnapshot(
    outputDirectory,
    payloads.map((payload) => {
      if (!PAYLOAD_RELATIVE_PATTERN.test(payload.path)) {
        throw new TypeError("Topik compiler payload path is not canonical");
      }
      return {
        bytes: payload.bytes,
        digest: payload.path.slice("blobs/".length),
      };
    }),
  );
}

async function removePublishedSnapshot(outputDirectory: URL): Promise<void> {
  await removeDigestSnapshot(outputDirectory);
}
