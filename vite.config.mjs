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
      reportUnusedDisableDirectives: "error",
      denyWarnings: true,
    },
    overrides: [
      {
        files: ["packages/content-react/**"],
        plugins: ["react", "jsx-a11y"],
        rules: {
          // Links receive their content through spread props, which the rule cannot see.
          "jsx-a11y/anchor-has-content": "off",
          // `role="status"` is part of the rendered markup that themes style.
          "jsx-a11y/prefer-tag-over-role": "off",
        },
      },
    ],
  },
  fmt: {
    ignorePatterns: ["packages/remark-tags/test/fixtures/**", "**/coverage/**"],
  },
});
