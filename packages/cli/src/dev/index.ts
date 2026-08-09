import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { command, positional, string } from "@drizzle-team/brocli";
import { watch, type Watcher } from "@topik/core";
import {
  deriveGitSourceNamespace,
  explicitAssetOptions,
  requiresSourceNamespace,
} from "../source-namespace";

const DEV_HOST = "127.0.0.1";
const DEFAULT_ALLOWED_ORIGIN = "https://write.subtopik.com";
const REQUEST_VARY_HEADERS = "Origin, Sec-Fetch-Site";

function sendSSE(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function handleResources(
  watcher: Watcher,
  res: ServerResponse,
  corsHeaders: Record<string, string>,
) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    ...corsHeaders,
  });
  res.end(
    JSON.stringify({
      resources: [...watcher.resources.values()],
      payloads: [...watcher.payloads.values()].map(({ bytes: _bytes, ...payload }) => payload),
    }),
  );
}

function handleEvents(watcher: Watcher, res: ServerResponse, corsHeaders: Record<string, string>) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...corsHeaders,
  });

  // Send initial sync with all current resources
  sendSSE(res, "sync", {
    resources: Object.fromEntries(watcher.resources),
    payloads: Object.fromEntries(
      [...watcher.payloads].map(([path, { bytes: _bytes, ...payload }]) => [path, payload]),
    ),
  });

  // Forward updates
  const onUpdate = (key: string, resource: unknown) => {
    sendSSE(res, "update", {
      key,
      resource,
    });
  };
  watcher.on("update", onUpdate);

  res.on("close", () => {
    watcher.off("update", onUpdate);
  });
}

function handleAssetPayload(
  watcher: Watcher,
  url: URL,
  res: ServerResponse,
  corsHeaders: Record<string, string>,
): boolean {
  if (!url.pathname.startsWith("/assets/sha256/")) {
    return false;
  }

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(url.pathname.slice(1));
  } catch {
    res.writeHead(404, corsHeaders);
    res.end();
    return true;
  }
  if (!/^assets\/sha256\/[0-9a-f]{64}$/u.test(relativePath)) {
    res.writeHead(404, corsHeaders);
    res.end();
    return true;
  }

  const payload = watcher.payloads.get(relativePath);
  if (payload === undefined) {
    res.writeHead(404, corsHeaders);
    res.end();
    return true;
  }

  const contentType = payload.mediaType;
  res.writeHead(200, {
    "Content-Type": contentType,
    ...corsHeaders,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...(isDownloadMediaType(contentType) ? { "Content-Disposition": "attachment" } : {}),
  });
  res.end(payload.bytes);

  return true;
}

function isDownloadMediaType(mediaType: string): boolean {
  return [
    "application/octet-stream",
    "text/html",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
    "application/x-executable",
    "application/wasm",
    "application/x-topik-active-content",
  ].includes(mediaType);
}

function normalizeAllowedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid browser origin: ${value}`);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin === "null" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`Invalid browser origin: ${value}`);
  }

  return url.origin;
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;

  const normalizedHost = host.toLowerCase();
  if (
    normalizedHost === `localhost:${port}` ||
    normalizedHost === `127.0.0.1:${port}` ||
    normalizedHost === `[::1]:${port}`
  ) {
    return true;
  }

  return (
    port === 80 &&
    (normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "[::1]")
  );
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

function getCorsHeaders(origin: string | undefined, allowedOrigin: string): Record<string, string> {
  return origin === allowedOrigin
    ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: REQUEST_VARY_HEADERS }
    : { Vary: REQUEST_VARY_HEADERS };
}

function rejectRequest(res: ServerResponse) {
  res.writeHead(403, { "Content-Type": "text/plain", Vary: REQUEST_VARY_HEADERS });
  res.end("Forbidden");
}

function createRequestHandler(watcher: Watcher, getPort: () => number, allowedOrigin: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (!isAllowedHost(req.headers.host, getPort())) {
      rejectRequest(res);
      return;
    }

    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    if (
      (origin !== undefined && origin !== allowedOrigin) ||
      (origin === undefined &&
        fetchSite !== undefined &&
        fetchSite !== "same-origin" &&
        fetchSite !== "none")
    ) {
      rejectRequest(res);
      return;
    }

    const corsHeaders = getCorsHeaders(origin, allowedOrigin);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://localhost:${getPort()}`);
    } catch {
      res.writeHead(400, {
        "Content-Type": "text/plain",
        ...corsHeaders,
      });
      res.end("Bad Request");
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        ...corsHeaders,
      });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/resources") {
      handleResources(watcher, res, corsHeaders);
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      handleEvents(watcher, res, corsHeaders);
      return;
    }

    if (req.method === "GET" && handleAssetPayload(watcher, url, res, corsHeaders)) {
      return;
    }

    res.writeHead(404, {
      "Content-Type": "text/plain",
      ...corsHeaders,
    });
    res.end("Not Found");
  };
}

export interface StartedDevServer {
  port: number;
  server: Server;
  watcher: Watcher;
  close: () => Promise<void>;
}

/** @internal */
export async function startDevServer(options: {
  dir: string;
  port: number;
  allowOrigin?: string;
  sourceNamespace?: string;
}): Promise<StartedDevServer> {
  const dir = resolve(options.dir);
  const allowedOrigin = normalizeAllowedOrigin(options.allowOrigin ?? DEFAULT_ALLOWED_ORIGIN);

  console.log(`Watching ${dir} for changes...`);
  const explicitAssets = explicitAssetOptions(options.sourceNamespace);
  let watcher: Watcher;
  try {
    watcher = await watch({ dir, assets: explicitAssets });
  } catch (error) {
    if (explicitAssets !== undefined || !requiresSourceNamespace(error)) throw error;
    watcher = await watch({
      dir,
      assets: { sourceNamespace: await deriveGitSourceNamespace(dir) },
    });
  }
  console.log(`Compiled ${watcher.resources.size} resources`);

  watcher.on("error", (error: Error) => {
    console.error("Compile error:", error.message);
  });

  watcher.on("update", (key: string) => {
    console.log(`Updated ${key}`);
  });

  let activePort = options.port;
  const server = createServer(createRequestHandler(watcher, () => activePort, allowedOrigin));

  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectListening(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string" || !isLoopbackAddress(address.address)) {
          server.close(() => {
            rejectListening(new Error("Dev server did not bind to a loopback address"));
          });
          return;
        }
        activePort = address.port;
        resolveListening();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(options.port, DEV_HOST);
    });
  } catch (error) {
    await watcher.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;

  return {
    port: activePort,
    server,
    watcher,
    close: () => {
      closePromise ??= (async () => {
        const serverClosed = server.listening
          ? new Promise<void>((resolveClosed, rejectClosed) => {
              server.close((error) => {
                if (error) rejectClosed(error);
                else resolveClosed();
              });
              server.closeAllConnections();
            })
          : Promise.resolve();

        await Promise.all([serverClosed, watcher.close()]);
      })();

      return closePromise;
    },
  };
}

export const dev = command({
  name: "dev",
  desc: "Start a development server that watches for content changes",
  options: {
    dir: positional("dir").desc("Path to the content directory").default("."),
    port: string("port").alias("p").desc("Port to listen on").default("50001"),
    allowOrigin: string("allow-origin").desc(
      `Browser origin allowed to connect (default: ${DEFAULT_ALLOWED_ORIGIN})`,
    ),
    sourceNamespace: string("source-namespace").desc(
      "Stable source namespace for implicit local Assets (derived from Git when omitted)",
    ),
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    const port = parseInt(options.port, 10);

    const runningServer = await startDevServer({
      dir,
      port,
      allowOrigin: options.allowOrigin,
      sourceNamespace: options.sourceNamespace,
    });
    console.log(`Dev server listening on http://localhost:${runningServer.port}`);

    process.once("SIGINT", async () => {
      await runningServer.close();
      process.exit(0);
    });
  },
});
