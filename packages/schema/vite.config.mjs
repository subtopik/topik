import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: {
      onlyBundle: ["json-schema-to-ts", "ts-algebra"],
    },
    dts: {
      tsgo: true,
    },
    exports: {
      customExports: {
        "./asset/v1.json": "./dist/asset-v1.json",
      },
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
