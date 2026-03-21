import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    external: [/^node:/, /^astro/],
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
