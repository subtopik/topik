import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/theme.ts"],
    dts: {
      tsgo: true,
    },
    exports: true,
    deps: {
      neverBundle: ["react", "react-dom", "react/jsx-runtime"],
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    environment: "jsdom",
  },
  fmt: {},
});
