import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { command, positional, string } from "@drizzle-team/brocli";
import { watch, type Resource, type Watcher } from "@topik/core";

const DEV_HOST = "127.0.0.1";
const DEFAULT_ALLOWED_ORIGIN = "https://write.subtopik.com";

const SAFE_READ_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
  (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);

const ASSET_EXTENSIONS: Record<string, string> = {
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
  res.end(JSON.stringify({ resources: [...watcher.resources.values()] }));
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
  });

  // Forward updates
  const onUpdate = (key: string, resource: unknown) => {
    sendSSE(res, "update", { key, resource });
  };
  watcher.on("update", onUpdate);

  res.on("close", () => {
    watcher.off("update", onUpdate);
  });
}

function getAsset(watcher: Watcher, name: string): Extract<Resource, { type: "Asset" }> | null {
  const resource = watcher.resources.get(`Asset/${name}`);
  return resource?.type === "Asset" ? resource : null;
}

function handleAsset(
  watcher: Watcher,
  dir: string,
  url: URL,
  res: ServerResponse,
  corsHeaders: Record<string, string>,
): boolean {
  if (!url.pathname.startsWith("/assets/")) {
    return false;
  }

  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice("/assets/".length));
  } catch {
    res.writeHead(404, corsHeaders);
    res.end();
    return true;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    res.writeHead(404, corsHeaders);
    res.end();
    return true;
  }

  const asset = getAsset(watcher, name);
  if (!asset) {
    res.writeHead(404, corsHeaders);
    res.end();
    return true;
  }

  let filePath: string;
  let realDir: string;
  let realFilePath: string;
  try {
    filePath = resolve(join(dir, asset.spec.uri));
    realDir = realpathSync(dir);
    realFilePath = realpathSync(filePath);
  } catch {
    res.writeHead(404, corsHeaders);
    res.end();
    return true;
  }

  const relativeAssetPath = relative(realDir, realFilePath);
  if (
    relativeAssetPath !== "" &&
    (relativeAssetPath === ".." ||
      relativeAssetPath.startsWith(`..${sep}`) ||
      isAbsolute(relativeAssetPath))
  ) {
    res.writeHead(404, corsHeaders);
    res.end();
    return true;
  }

  readRegularFile(realFilePath)
    .then((data) => {
      res.writeHead(200, {
        "Content-Type":
          asset.spec.mediaType ?? ASSET_EXTENSIONS[extname(filePath)] ?? "application/octet-stream",
        ...corsHeaders,
        "Cache-Control": "no-cache",
      });
      res.end(data);
    })
    .catch(() => {
      res.writeHead(500, corsHeaders);
      res.end();
    });

  return true;
}

async function readRegularFile(filePath: string): Promise<Buffer> {
  const file = await open(filePath, SAFE_READ_FLAGS);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error(`Asset is not a regular file: ${filePath}`);
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
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
    ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
    : { Vary: "Origin" };
}

function rejectRequest(res: ServerResponse) {
  res.writeHead(403, { "Content-Type": "text/plain", Vary: "Origin" });
  res.end("Forbidden");
}

function createRequestHandler(
  watcher: Watcher,
  dir: string,
  getPort: () => number,
  allowedOrigin: string,
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (!isAllowedHost(req.headers.host, getPort())) {
      rejectRequest(res);
      return;
    }

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== allowedOrigin) {
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

    const url = new URL(req.url ?? "/", `http://localhost:${getPort()}`);

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

    if (req.method === "GET" && handleAsset(watcher, dir, url, res, corsHeaders)) {
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
}): Promise<StartedDevServer> {
  const dir = resolve(options.dir);
  const allowedOrigin = normalizeAllowedOrigin(options.allowOrigin ?? DEFAULT_ALLOWED_ORIGIN);

  console.log(`Watching ${dir} for changes...`);
  const watcher = await watch({ dir });
  console.log(`Compiled ${watcher.resources.size} resources`);

  watcher.on("error", (error: Error) => {
    console.error("Compile error:", error.message);
  });

  watcher.on("update", (key: string) => {
    console.log(`Updated ${key}`);
  });

  let activePort = options.port;
  const server = createServer(createRequestHandler(watcher, dir, () => activePort, allowedOrigin));

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
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    const port = parseInt(options.port, 10);

    const runningServer = await startDevServer({
      dir,
      port,
      allowOrigin: options.allowOrigin,
    });
    console.log(`Dev server listening on http://localhost:${runningServer.port}`);

    process.once("SIGINT", async () => {
      await runningServer.close();
      process.exit(0);
    });
  },
});
