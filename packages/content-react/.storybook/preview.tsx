import type { Preview } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { INITIAL_VIEWPORTS } from "storybook/viewport";
import { TopikContentProvider } from "../src/core/context";
import "../src/theme/styles.css";
import "./preview.css";

const preview: Preview = {
  tags: ["autodocs"],
  globalTypes: {
    theme: {
      description: "Content color scheme",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: ["light", "dark"],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  parameters: {
    layout: "fullscreen",
    backgrounds: { disable: true },
    viewport: { options: INITIAL_VIEWPORTS },
    a11y: { test: "error" },
    controls: { expanded: true },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === "dark" ? "dark" : "light";
      return (
        <div className={`storybook-frame ${theme}`}>
          <TopikContentProvider colorScheme={theme} onNavigateLink={interceptNavigation}>
            <div className="topik-content storybook-content">
              <Story />
            </div>
          </TopikContentProvider>
        </div>
      );
    },
  ],
};

// Keep example links inside the canvas and expose navigation in the Actions panel.
const interceptNavigation = fn(() => true).mockName("onNavigateLink");

export default preview;
