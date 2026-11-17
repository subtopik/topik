import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: "src/cli.ts",
    tsconfig: "tsconfig.build.json",
    dts: true,
    exports: {
      bin: {
        topik: "src/cli.ts",
      },
    },
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
