import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: "src/cli.ts",
    // The CLI exports no types; emit its declaration without compiling the
    // build-time content internals into their sibling source directories.
    dts: { generator: "oxc" },
    exports: {
      bin: {
        "topik-codemod": "src/cli.ts",
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
