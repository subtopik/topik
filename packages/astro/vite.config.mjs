import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: {
      neverBundle: [/^node:/, /^astro/],
    },
    dts: true,
    exports: true,
  },
  test: {
    // Loaded CI runners are several times slower than a local run.
    testTimeout: 20_000,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
