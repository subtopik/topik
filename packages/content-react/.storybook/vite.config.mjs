import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [
    storybookTest({
      configDir: fileURLToPath(new URL(".", import.meta.url)),
      storybookScript: "vp run storybook --ci",
    }),
  ],
  test: {
    name: "storybook",
    testTimeout: 15000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
