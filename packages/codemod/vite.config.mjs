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
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
