import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: "src/index.ts",
    dts: true,
    exports: true,
    deps: {
      // Keep mdast/unist shared so consumers see our node-map augmentations.
      neverBundle: ["@types/mdast", "@types/unist", "mdast", "unist"],
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-helpers.ts", "src/test-fixtures/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
