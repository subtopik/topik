import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: true,
    exports: true,
    deps: {
      neverBundle: ["micromark-util-types", "@types/mdast", "@types/unist", "mdast", "unist"],
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-support.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
