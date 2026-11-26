import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: "src/index.ts",
    // Publish one file per source module so a consumer bundler can place small
    // utilities, parsing, analysis and serialization in different chunks.
    unbundle: true,
    dts: true,
    exports: true,
    deps: {
      // Keep mdast/unist shared so consumers see our node-map augmentations.
      neverBundle: ["@types/mdast", "@types/unist", "mdast", "unist"],
    },
  },
  fmt: {},
  test: {
    // Loaded CI runners are several times slower than a local run.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-helpers.ts", "src/test-fixtures/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
