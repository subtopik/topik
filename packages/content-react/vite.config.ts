import { defineConfig } from "vite-plus";

const contentSchemaSource = new URL("../content-schema/src/index.ts", import.meta.url).pathname;

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/theme.ts", "src/rich.tsx"],
    dts: {
      tsgo: true,
    },
    exports: {
      customExports: {
        "./rich/styles.css": "./dist/rich/styles.css",
        "./theme/styles.css": "./dist/theme/styles.css",
      },
    },
    deps: {
      neverBundle: ["katex", "mermaid", "react", "react-dom", "react/jsx-runtime", "shiki"],
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    alias: {
      "@topik/content-schema": contentSchemaSource,
    },
    environment: "jsdom",
  },
  fmt: {},
});
