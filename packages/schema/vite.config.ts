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
        "./asset-manifest/v1.json": "./dist/asset-manifest-v1.json",
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
