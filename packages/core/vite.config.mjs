import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/wiki-navigation.ts", "src/course-navigation.ts", "src/preview.ts"],
    tsconfig: "tsconfig.build.json",
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
