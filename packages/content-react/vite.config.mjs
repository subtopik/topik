import { defineConfig } from "vite-plus";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const contentSource = fileURLToPath(new URL("../content/src/index.ts", import.meta.url));

const sourceRoot = fileURLToPath(new URL("src/", import.meta.url));
const clientModules = new Map();
const entry = ["src/index.ts", "src/preview-assets.ts", "src/theme.ts", "src/rich.tsx"];
const entries = new Set(entry.map((path) => fileURLToPath(new URL(path, import.meta.url))));

/** Source modules that start with a "use client" directive (React client boundaries). */
function isClientModule(id) {
  if (!id.startsWith(sourceRoot) || !/\.tsx?$/.test(id) || id.endsWith(".d.ts")) return false;
  let client = clientModules.get(id);
  if (client === undefined) {
    client = /^\s*["']use client["']/.test(readFileSync(id, "utf8"));
    clientModules.set(id, client);
  }
  return client;
}

/**
 * Rolldown drops module directives when bundling. Give each client module its own chunk and
 * restore the directive there, so server-component bundlers see client references while the root
 * entry's pure functions stay importable under the react-server condition.
 */
const clientDirective = {
  name: "topik-client-directive",
  outputOptions(options) {
    return {
      ...options,
      codeSplitting: {
        groups: [
          {
            // Pure dependencies stay out, so server-safe code never inherits the directive.
            includeDependenciesRecursively: false,
            // Entry modules keep their own chunk; the root entry itself is not a client module.
            name: (id) =>
              isClientModule(id) && !entries.has(id) ? basename(id).replace(/\.tsx?$/, "") : null,
          },
        ],
      },
    };
  },
  renderChunk(code, chunk) {
    if (!chunk.fileName.endsWith(".mjs") || /^["']use client["']/.test(code)) return null;
    if (!chunk.moduleIds.some(isClientModule)) return null;
    return { code: `"use client";\n${code}`, map: null };
  },
};

const config = defineConfig({
  pack: {
    entry,
    plugins: [clientDirective],
    dts: true,
    exports: {
      customExports: {
        "./rich/styles.css": "./dist/rich/styles.css",
        "./theme/styles.css": "./dist/theme/styles.css",
      },
    },
    deps: {
      neverBundle: [
        "katex",
        "pele",
        "react",
        "react-dom",
        "react/jsx-dev-runtime",
        "react/jsx-runtime",
        // Rich code loads Shiki's fine-grained subpaths (core, langs, themes, engines, wasm).
        /^shiki(?:\/|$)/u,
      ],
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    // Loaded CI runners are several times slower than a local run.
    testTimeout: 20_000,
    alias: {
      "@topik/content": contentSource,
    },
    environment: "jsdom",
    restoreMocks: true,
  },
  fmt: {},
});

// The Storybook test panel discovers this config and sets VITEST_STORYBOOK.
// Keep its browser project separate from normal vp test runs.
export default process.env.VITEST_STORYBOOK === "true"
  ? (await import("./.storybook/vite.config.mjs")).default
  : config;
