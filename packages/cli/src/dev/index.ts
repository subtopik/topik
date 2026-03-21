import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { command, positional, string } from "@drizzle-team/brocli";
import { watch, type Watcher } from "@topik/core";

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

      if (req.method === "GET") {
        const ext = extname(url.pathname);
        const mime = ASSET_EXTENSIONS[ext];
        if (mime) {
          const filePath = resolve(join(dir, url.pathname));
          if (filePath.startsWith(dir + "/") && existsSync(filePath)) {
            readFile(filePath)
              .then((data) => {
                res.writeHead(200, {
                  "Content-Type": mime,
                  "Access-Control-Allow-Origin": "*",
                });
                res.end(data);
              })
              .catch(() => {
                res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
                res.end();
              });

            return;
          }
        }
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
