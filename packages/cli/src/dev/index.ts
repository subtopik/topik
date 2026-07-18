import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { command, positional, string } from "@drizzle-team/brocli";
import { watch, type Resource, type Watcher } from "@topik/core";

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

function handleResources(watcher: Watcher, _req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify({ resources: [...watcher.resources.values()] }));
}

function handleEvents(watcher: Watcher, _req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
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

function handleAsset(watcher: Watcher, dir: string, url: URL, res: ServerResponse): boolean {
  if (!url.pathname.startsWith("/assets/")) {
    return false;
  }

  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice("/assets/".length));
  } catch {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return true;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return true;
  }

  const asset = getAsset(watcher, name);
  if (!asset) {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
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
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
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
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return true;
  }

  readRegularFile(realFilePath)
    .then((data) => {
      res.writeHead(200, {
        "Content-Type":
          asset.spec.mediaType ?? ASSET_EXTENSIONS[extname(filePath)] ?? "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    })
    .catch(() => {
      res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
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

export const dev = command({
  name: "dev",
  desc: "Start a development server that watches for content changes",
  options: {
    dir: positional("dir").desc("Path to the content directory").default("."),
    port: string("port").alias("p").desc("Port to listen on").default("50001"),
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    const port = parseInt(options.port, 10);

    console.log(`Watching ${dir} for changes...`);
    const watcher = await watch({ dir });
    console.log(`Compiled ${watcher.resources.size} resources`);

    watcher.on("error", (error: Error) => {
      console.error("Compile error:", error.message);
    });

    watcher.on("update", (key: string) => {
      console.log(`Updated ${key}`);
    });

    const server = createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/resources") {
        handleResources(watcher, req, res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        handleEvents(watcher, req, res);
        return;
      }

      if (req.method === "GET" && handleAsset(watcher, dir, url, res)) {
        return;
      }

      res.writeHead(404, {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      });
      res.end("Not Found");
    });

    server.listen(port, () => {
      console.log(`Dev server listening on http://localhost:${port}`);
    });

    process.on("SIGINT", async () => {
      server.close();
      await watcher.close();
      process.exit(0);
    });
  },
});
