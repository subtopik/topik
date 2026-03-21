import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: {
      onlyBundle: ["json-schema-to-ts", "ts-algebra"],
    },
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
