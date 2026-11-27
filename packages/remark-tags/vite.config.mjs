import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Keep syntax, mdast conversion and serialization in separate modules so
    // consumer bundlers can split them across chunks.
    unbundle: true,
    dts: true,
    exports: true,
    deps: {
      neverBundle: ["micromark-util-types", "@types/mdast", "@types/unist", "mdast", "unist"],
    },
  },
  test: {
    // Loaded CI runners are several times slower than a local run.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-support.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
