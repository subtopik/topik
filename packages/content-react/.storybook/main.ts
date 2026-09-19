import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  staticDirs: ["./public"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  viteFinal(config) {
    return mergeConfig(config, {
      resolve: {
        alias: {
          "@topik/content-schema": fileURLToPath(
            new URL("../../content-schema/src/index.ts", import.meta.url),
          ),
        },
      },
    });
  },
};

export default config;
