import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { command, positional, string } from "@drizzle-team/brocli";
import {
  CompileError,
  DEFAULT_FILE_SAFETY,
  isTopikDownloadOnlyMediaType,
  watch,
  type FileSafety,
  TOPIK_PREVIEW_PROTOCOL,
  type LinkValidationPolicy,
  type PreviewState,
  type Watcher,
} from "@topik/core";

import { version } from "../../package.json";

import { printDiagnostics, printPreviewWarnings } from "../diagnostics";
import { formatPublicCliError, PublicCliError, withProjectPlatformRequirement } from "../errors";
import { fileSafetyOption, notePortableReads } from "../file-safety";

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
    "Cache-Control": "no-store",
    ...corsHeaders,
  });
  res.end(JSON.stringify(watcher.state));
}

function handleEvents(watcher: Watcher, res: ServerResponse, corsHeaders: Record<string, string>) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...corsHeaders,
  });

  sendSSE(res, "preview-state", watcher.state);
  const onState = (state: PreviewState) => sendSSE(res, "preview-state", state);
  watcher.on("preview-state", onState);
  res.on("close", () => watcher.off("preview-state", onState));
}

type ByteRange = { start: number; end: number } | "unsatisfiable" | undefined;

/**
 * Parse a single `bytes` range (RFC 9110). Browsers request media in ranges to start playback
 * early and to seek. Absent, malformed and multiple ranges are ignored: the whole payload follows.
 */
function parseByteRange(header: string | undefined, size: number): ByteRange {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/iu.exec(header.trim());
  if (match === null) return undefined;
  const [, first, last] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    // A suffix range: the final bytes of the payload.
    const length = Number(last);
    if (!Number.isSafeInteger(length)) return undefined;
    return length === 0 || size === 0
      ? "unsatisfiable"
      : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? Number.MAX_SAFE_INTEGER : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  return start >= size ? "unsatisfiable" : { start, end: Math.min(end, size - 1) };
}

function handleAssetPayload(
  watcher: Watcher,
  rawPathname: string,
  method: "GET" | "HEAD",
  rangeHeader: string | undefined,
  res: ServerResponse,
  corsHeaders: Record<string, string>,
): boolean {
  if (!rawPathname.startsWith("/blobs/")) {
    return false;
  }

  const relativePath = rawPathname.slice(1);
  if (!/^blobs\/[0-9a-f]{64}$/u.test(relativePath)) {
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
  const headers = {
    "Content-Type": contentType,
    ...corsHeaders,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...(isTopikDownloadOnlyMediaType(contentType) ? { "Content-Disposition": "attachment" } : {}),
  };
  const range = parseByteRange(rangeHeader, payload.size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${payload.size}` });
    res.end();
    return true;
  }
  if (range !== undefined) {
    res.writeHead(206, {
      ...headers,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${payload.size}`,
    });
    res.end(payload.bytes.subarray(range.start, range.end + 1));
    return true;
  }
  res.writeHead(200, { ...headers, "Content-Length": String(payload.size) });
  res.end(method === "HEAD" ? undefined : payload.bytes);

  return true;
}

function normalizeAllowedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicCliError("browser-origin-invalid");
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
    throw new PublicCliError("browser-origin-invalid");
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
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
      });
      res.end();
      return;
    }

    const requestTarget = req.url ?? "/";
    let url: URL;
    try {
      url = new URL(requestTarget, `http://localhost:${getPort()}`);
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
        "Cache-Control": "no-store",
        ...corsHeaders,
      });
      res.end(
        JSON.stringify({
          status: "ok",
          version,
          capabilities: [TOPIK_PREVIEW_PROTOCOL],
          sessionId: watcher.state.sessionId,
        }),
      );
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

    // Opt-in identity binding prevents stale clients reading from a restarted producer.
    if (
      url.pathname.startsWith("/blobs/") &&
      (url.searchParams.has("sessionId") || url.searchParams.has("generation"))
    ) {
      if (
        url.searchParams.getAll("sessionId").length !== 1 ||
        url.searchParams.getAll("generation").length !== 1 ||
        url.searchParams.get("sessionId") !== watcher.state.sessionId ||
        url.searchParams.get("generation") !== String(watcher.state.generation)
      ) {
        res.writeHead(409, { ...corsHeaders, "Cache-Control": "no-store" });
        res.end();
        return;
      }
    }
    const queryOffset = requestTarget.indexOf("?");
    const rawPathname = queryOffset === -1 ? requestTarget : requestTarget.slice(0, queryOffset);
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      handleAssetPayload(
        watcher,
        rawPathname,
        req.method,
        // Ranges apply to GET only. Payload responses carry no validator, so a conditional
        // If-Range cannot match and the whole payload follows (RFC 9110).
        req.method === "GET" && req.headers["if-range"] === undefined
          ? req.headers.range
          : undefined,
        res,
        corsHeaders,
      )
    ) {
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
  links?: LinkValidationPolicy;
  fileSafety?: FileSafety;
}): Promise<StartedDevServer> {
  const dir = resolve(options.dir);
  const allowedOrigin = normalizeAllowedOrigin(options.allowOrigin ?? DEFAULT_ALLOWED_ORIGIN);
  await assertSourceDirectory(dir);

  const fileSafety = options.fileSafety ?? DEFAULT_FILE_SAFETY;
  // Once per run: every recompilation uses the same mode.
  notePortableReads(fileSafety);
  console.log("Watching content for changes...");
  let initialCompile = true;
  let platformFailure: PublicCliError | undefined;
  const watcher = await watch({
    dir,
    validation: { links: options.links ?? "error" },
    fileSafety,
    // Registered before the initial compile so its failure is reported too.
    onError: (error) => {
      const platformError = withProjectPlatformRequirement(error);
      if (initialCompile && platformError instanceof PublicCliError) {
        platformFailure = platformError;
        return;
      }
      reportWatchError(error);
    },
  });
  initialCompile = false;
  // No later edit can make this platform readable: stop instead of serving an error state.
  if (platformFailure !== undefined) {
    await watcher.close();
    throw platformFailure;
  }
  // Errors arrive through onError; each new generation, with its warnings, from the state.
  let reportedGeneration: number | null = null;
  const reportGeneration = (state: PreviewState) => {
    if (state.status !== "ready" || state.generation === reportedGeneration) return;
    reportedGeneration = state.generation;
    console.log(`Compiled ${state.resources.length} resources`);
    printPreviewWarnings(state);
  };
  reportGeneration(watcher.state);
  watcher.on("preview-state", reportGeneration);

  let activePort = options.port;
  const server = createServer(createRequestHandler(watcher, () => activePort, allowedOrigin));

  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        rejectListening(
          new PublicCliError(
            error.code === "EADDRINUSE" ? "dev-port-in-use" : "dev-server-listen-failed",
            { cause: error },
          ),
        );
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

/**
 * Print compile failures to the local terminal. The preview protocol omits source
 * paths, but the person running the dev server needs the located diagnostics.
 */
function reportWatchError(error: Error): void {
  if (error instanceof CompileError) {
    console.error("Compile error:");
    printDiagnostics(error.diagnostics);
    return;
  }
  console.error("Compile error:", formatPublicCliError(withProjectPlatformRequirement(error)));
}

async function assertSourceDirectory(dir: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined);
  if (info?.isDirectory() !== true) throw new PublicCliError("dev-source-access-failed");
}

export const dev = command({
  name: "dev",
  desc: "Start a development server that watches for content changes",
  options: {
    dir: positional("dir").desc("Project directory containing .topik.yaml").default("."),
    port: string("port").alias("p").desc("Port to listen on").default("50001"),
    allowOrigin: string("allow-origin").desc(
      `Browser origin allowed to connect (default: ${DEFAULT_ALLOWED_ORIGIN})`,
    ),
    links: string("links")
      .desc("How unresolved wiki links and local guide fragments are handled")
      .enum("error", "warning", "off")
      .default("error"),
    fileSafety: fileSafetyOption(),
  },
  handler: async (options) => {
    const port = parseDevPort(options.port);
    const dir = resolve(options.dir);

    const runningServer = await startDevServer({
      dir,
      port,
      allowOrigin: options.allowOrigin,
      links: options.links as LinkValidationPolicy,
      fileSafety: options.fileSafety,
    });
    console.log(`Dev server listening on http://localhost:${runningServer.port}`);

    installShutdownHandlers(runningServer);
  },
});

/** @internal Parse a `--port` value strictly: decimal digits only, 0 to 65535. */
export function parseDevPort(value: string): number {
  const port = /^\d{1,5}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new PublicCliError("dev-port-invalid");
  }
  return port;
}

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** @internal Close the server once on the first shutdown signal, then exit. */
export function installShutdownHandlers(
  runningServer: Pick<StartedDevServer, "close">,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runningServer.close().then(
      () => exit(0),
      (error: unknown) => {
        console.error(formatPublicCliError(error));
        exit(1);
      },
    );
  };
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, shutdown);
  return () => {
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, shutdown);
  };
}
