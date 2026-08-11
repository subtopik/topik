import { writeFile } from "node:fs/promises";
import type { AstroIntegration } from "astro";
import {
  assertTopikAssetLoaders,
  collectTopikAssetPayloads,
  collectTopikAssetUrls,
  findTopikAssetPayload,
  refreshTopikAssetSnapshots,
  type TopikAssetLoader,
} from "./assets";
import { publishDigestSnapshot, removeDigestSnapshot } from "./publication";

export type { TopikAssetLoader } from "./assets";

export interface TopikOptions {
  /** Topik Guide/Wiki loaders whose complete compiler snapshot is delivered. */
  loaders: readonly TopikAssetLoader[];
}

const PAYLOAD_PATH_PATTERN = /^\/assets\/sha256\/[0-9a-f]{64}$/u;
const PAYLOAD_RELATIVE_PATTERN = /^assets\/sha256\/[0-9a-f]{64}$/u;
const VIRTUAL_SNAPSHOT_ID = "virtual:@topik/astro/asset-snapshot";
const RESOLVED_VIRTUAL_SNAPSHOT_ID = `\0${VIRTUAL_SNAPSHOT_ID}`;

export function topik(options: TopikOptions): AstroIntegration {
  assertTopikAssetLoaders(options.loaders);
  const loaders = [...options.loaders];

  return {
    name: "@topik/astro",
    hooks: {
      "astro:config:setup": async ({
        addMiddleware,
        command,
        config,
        createCodegenDir,
        updateConfig,
      }) => {
        if (command === "build") {
          await removePublishedSnapshot(
            config.output === "server" ? config.build.client : config.outDir,
          );
        }
        const codegenDir = createCodegenDir();
        const middleware = new URL("topik-asset-middleware.mjs", codegenDir);
        await writeFile(middleware, productionMiddlewareSource(), { encoding: "utf8" });
        addMiddleware({ entrypoint: middleware, order: "pre" });
        updateConfig({ vite: { plugins: [snapshotPlugin(loaders)] } });
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

function snapshotPlugin(loaders: readonly TopikAssetLoader[]) {
  return {
    name: "@topik/astro:asset-snapshot",
    resolveId(id: string) {
      return id === VIRTUAL_SNAPSHOT_ID ? RESOLVED_VIRTUAL_SNAPSHOT_ID : undefined;
    },
    load(id: string) {
      if (id !== RESOLVED_VIRTUAL_SNAPSHOT_ID) return undefined;
      const records = collectTopikAssetPayloads(loaders).map((payload) => [
        `/${payload.path}`,
        payload.mediaType,
        payload.size,
        Buffer.from(payload.bytes).toString("base64"),
      ]);
      const urls = [...collectTopikAssetUrls(loaders)];
      return `const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));\nexport const topikAssetPayloads = new Map(${JSON.stringify(records)}.map(([path, mediaType, size, bytes]) => [path, { bytes: decode(bytes), mediaType, size }]));\nexport const topikAssetUrls = new Map(${JSON.stringify(urls)});\n`;
    },
  };
}

function productionMiddlewareSource(): string {
  return `import { topikAssetPayloads, topikAssetUrls } from ${JSON.stringify(VIRTUAL_SNAPSHOT_ID)};
globalThis[Symbol.for("@topik/astro/runtime-asset-urls")] = topikAssetUrls;
const pattern = /^\\/assets\\/sha256\\/[0-9a-f]{64}$/u;
export async function onRequest(context, next) {
  const request = context.request;
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  const pathname = new URL(request.url).pathname;
  if (!pattern.test(pathname)) return next();
  const payload = topikAssetPayloads.get(pathname);
  if (payload === undefined) return next();
  return new Response(request.method === "HEAD" ? null : payload.bytes, {
    headers: {
      "Content-Length": String(payload.size),
      "Content-Type": payload.mediaType,
      "X-Content-Type-Options": "nosniff",
    },
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
        digest: payload.path.slice("assets/sha256/".length),
      };
    }),
  );
}

async function removePublishedSnapshot(outputDirectory: URL): Promise<void> {
  await removeDigestSnapshot(outputDirectory);
}
