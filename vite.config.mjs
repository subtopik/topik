import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
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
  fmt: {
    ignorePatterns: ["packages/remark-tags/test/fixtures/**", "**/coverage/**"],
  },
});
