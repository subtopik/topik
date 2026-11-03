import { fileURLToPath } from "node:url";
import { defineConfig, lazyPlugins } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [
    // Vite+ also reads this configuration while discovering workspace tasks.
    lazyPlugins(async () => {
      const { storybookTest } = await import("@storybook/addon-vitest/vitest-plugin");
      return storybookTest({
        configDir: fileURLToPath(new URL(".", import.meta.url)),
        storybookScript: "vp run storybook --ci",
      });
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
