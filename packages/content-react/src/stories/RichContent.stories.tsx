import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, spyOn, waitFor } from "storybook/test";
import { RichTopikContentProvider } from "../rich";
import { TopikContent } from "../theme/TopikContent";
import "../rich/styles.css";
import "katex/dist/katex.min.css";

const code = "const message = 'Hello, Topik!';";
const writeClipboard = fn<(text: string) => Promise<void>>()
  .mockResolvedValue(undefined)
  .mockName("clipboard.writeText");
const mermaid = [
  "```mermaid",
  "graph TD",
  "  accTitle: Content publishing",
  "  accDescr: Write content, validate it, then publish it.",
  "  Write --> Validate --> Publish",
  "```",
].join("\n");

const meta = {
  title: "Content React/Rich content",
  component: TopikContent,
  args: { content: "" },
  decorators: [
    (Story, { globals }) => (
      <RichTopikContentProvider
        theme={globals.theme === "dark" ? "dark" : "light"}
        colorScheme={globals.theme === "dark" ? "dark" : "light"}
      >
        <Story />
      </RichTopikContentProvider>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Real KaTeX, Shiki, and Mermaid rendering through RichTopikContentProvider. Install the optional peers katex, shiki, and mermaid, then import the theme CSS, rich/styles.css, and katex/dist/katex.min.css. Rich content loads asynchronously; Mermaid shows a loading placeholder and falls back to source on failure. Use the Theme toolbar to change the rich provider and surrounding content together.",
      },
    },
  },
} satisfies Meta<typeof TopikContent>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DisplayMath: Story = {
  args: { content: '{% math content="E = mc^2" /%}' },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector(".katex-display")).toBeVisible(), {
      timeout: 10000,
    });
  },
};

export const InlineMath: Story = {
  args: {
    content: 'The identity {% mathInline content="x^2 + y^2 = z^2" /%} stays within this sentence.',
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => expect(canvasElement.querySelector(".topik-rich-math-inline .katex")).toBeVisible(),
      { timeout: 10000 },
    );
    await expect(canvasElement.querySelector(".katex-display")).toBeNull();
  },
};

export const HighlightedCode: Story = {
  args: { content: `\`\`\`ts\n${code}\n\`\`\`` },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector("pre.shiki")).toHaveTextContent(code), {
      timeout: 10000,
    });
  },
};

export const CopyCode: Story = {
  ...HighlightedCode,
  parameters: {
    docs: {
      description: {
        story:
          "The clipboard API is mocked for this automated example so it can verify the copied text without changing your clipboard or requiring browser permissions.",
      },
    },
  },
  beforeEach: () => {
    writeClipboard.mockClear();
    const writeText = spyOn(navigator.clipboard, "writeText").mockImplementation(writeClipboard);
    return () => writeText.mockRestore();
  },
  play: async (context) => {
    await HighlightedCode.play?.(context);
    await context.userEvent.click(context.canvas.getByRole("button", { name: "Copy" }));
    // Synthetic clicks do not establish CSS :hover. Check the announced state and payload.
    await expect(
      await context.canvas.findByRole("button", { name: "Copied" }),
    ).toHaveAccessibleName("Copied");
    await expect(writeClipboard).toHaveBeenCalledWith(`${code}\n`);
  },
};

export const Diagram: Story = {
  args: { content: mermaid },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => expect(canvasElement.querySelector(".topik-rich-mermaid svg")).toBeVisible(),
      { timeout: 10000 },
    );
    await expect(canvasElement.querySelector(".topik-rich-mermaid--loading")).toBeNull();
    await expect(canvasElement.querySelector("pre.topik-mermaid")).toBeNull();
  },
};

export const InvalidDiagram: Story = {
  args: { content: "```mermaid\nThis is not valid Mermaid syntax.\n```" },
  parameters: {
    docs: {
      description: {
        story:
          "A deliberate renderer failure. The expected console warning accompanies readable source fallback.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () =>
        expect(canvasElement.querySelector("pre.topik-mermaid")).toHaveTextContent(
          "This is not valid Mermaid syntax.",
        ),
      { timeout: 10000 },
    );
    await expect(canvasElement.querySelector(".topik-rich-mermaid--loading")).toBeNull();
  },
};

export const DarkRichContent: Story = {
  globals: { theme: "dark" },
  args: {
    content: [HighlightedCode.args!.content, DisplayMath.args!.content, mermaid].join("\n\n"),
  },
  play: async (context) => {
    await HighlightedCode.play?.(context);
    await DisplayMath.play?.(context);
    await Diagram.play?.(context);
  },
};

export const NarrowCode: Story = {
  args: {
    content:
      "```ts\nconst message = 'A deliberately long line of code that should scroll inside its frame without making the entire page wider than a small mobile screen.';\n```",
  },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector("pre.shiki")).toBeVisible(), {
      timeout: 10000,
    });
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
