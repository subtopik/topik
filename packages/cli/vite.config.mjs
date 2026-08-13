import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: "src/cli.ts",
    tsconfig: "tsconfig.build.json",
    dts: {
      tsgo: true,
    },
    exports: {
      bin: {
        topik: "src/cli.ts",
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
