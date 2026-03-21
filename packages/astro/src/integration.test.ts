import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { topik } from "./integration";

interface MockResponse {
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
}

function createMiddleware(dirs: string[]) {
  let middleware:
    | ((req: { url?: string }, res: MockResponse, next: () => void) => void)
    | undefined;

  const integration = topik({ dirs });
  void integration.hooks["astro:server:setup"]?.({
    server: {
      middlewares: {
        use(fn: (req: { url?: string }, res: MockResponse, next: () => void) => void) {
          middleware = fn;
        },
      },
    },
  } as never);

  if (!middleware) {
    throw new Error("Expected astro:server:setup to register a middleware");
  }

  return middleware;
}

function createResponse(): MockResponse {
  return {
    end: vi.fn(),
    setHeader: vi.fn(),
  };
}

describe("topik integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-astro-integration-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("serves static assets from configured content directories", async () => {
    await mkdir(join(dir, "images"), { recursive: true });
    await writeFile(join(dir, "images", "logo.png"), "asset-bytes");

    const middleware = createMiddleware([dir]);
    const response = createResponse();
    const next = vi.fn();

    middleware({ url: "/images/logo.png" }, response, next);
    await vi.waitFor(() => expect(response.end).toHaveBeenCalled());

    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(response.end).toHaveBeenCalledWith(expect.any(Buffer));
    expect(next).not.toHaveBeenCalled();
  });

  test("falls through for non-asset requests", () => {
    const middleware = createMiddleware([dir]);
    const response = createResponse();
    const next = vi.fn();

    middleware({ url: "/docs/getting-started" }, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.end).not.toHaveBeenCalled();
  });

  test("rejects directory traversal attempts", () => {
    const middleware = createMiddleware([dir]);
    const response = createResponse();
    const next = vi.fn();

    middleware({ url: "/../secret.png" }, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.end).not.toHaveBeenCalled();
  });
});
