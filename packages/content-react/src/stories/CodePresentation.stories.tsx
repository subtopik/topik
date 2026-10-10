import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, spyOn, waitFor } from "storybook/test";
import { RichTopikContentProvider } from "../rich";
import { TopikContent } from "../theme/TopikContent";
import "../rich/styles.css";

const payload = "\tconst answer = 42;  \n+source marker\n-source marker\n<tag>&amp;\n\n";
const source = [
  '```ts filename="client.ts" title="Client update" lines startLine=90 highlight="2,4" focus="2-4" collapseAfter=2 wrap=false added="2" removed="3"',
  payload,
  "```",
].join("\n");
const writeClipboard = fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
const alignmentPayload = [
  "const first = 1;",
  "const focused = 2;",
  "const added = 3;",
  "const removed = 4;",
  "const highlighted = 5;",
  "const last = 6;",
].join("\n");
const alignmentSource = [
  '```ts lines startLine=9998 focus="2-4" added="3" removed="4" highlight="5"',
  alignmentPayload,
  "```",
].join("\n");
const longTokenPayload = [
  `const url = "https://example.com/${"abcdefghij".repeat(20)}";`,
  `const token = "${"0123456789".repeat(20)}";`,
].join("\n");
const longTokenSource = [
  `\`\`\`ts\n${longTokenPayload}\n\`\`\``,
  `\`\`\`ts lines wrap=false\n${longTokenPayload}\n\`\`\``,
].join("\n\n");

const meta = {
  title: "Content React/Code presentation",
  component: TopikContent,
  args: { content: source },
  beforeEach: () => {
    writeClipboard.mockClear();
    const writeText = spyOn(navigator.clipboard, "writeText").mockImplementation(writeClipboard);
    return () => writeText.mockRestore();
  },
} satisfies Meta<typeof TopikContent>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const rows = canvasElement.querySelectorAll<HTMLElement>("[data-line]");
    await expect(rows).toHaveLength(6);
    await expect(rows[0]).toBeVisible();
    await expect(rows[2]).not.toBeVisible();
    await expect(canvas.getByText("Client update")).toBeVisible();
    await expect(canvas.getByText("client.ts")).toBeVisible();
    await expect(canvas.getByText("+ Added line")).toBeVisible();
    await expect(canvas.getByText("− Removed line")).toBeVisible();

    const copy = canvas.getByRole("button", { name: /^Copy$/ });
    copy.focus();
    await userEvent.keyboard("{Enter}");
    await expect(writeClipboard).toHaveBeenLastCalledWith(`${payload}\n`);

    const expand = canvas.getByRole("button", { name: "Show all 6 lines" });
    expand.focus();
    await userEvent.keyboard(" ");
    await expect(expand).toHaveFocus();
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    await expect(rows[2]).toBeVisible();
    await expect(rows[0].getBoundingClientRect().height).toBeCloseTo(
      Number.parseFloat(getComputedStyle(rows[0]).lineHeight),
      1,
    );
    await expect(rows[5].getBoundingClientRect().height).toBeCloseTo(
      Number.parseFloat(getComputedStyle(rows[5]).lineHeight),
      1,
    );
    await expect(rows[2].querySelector(".topik-code-block__diff-marker")).toHaveTextContent("−");
    await expect(rows[2].querySelector(".topik-code-block__sr-only")).toHaveTextContent(
      "Removed line:",
    );

    const wrap = canvas.getByRole("button", { name: "Wrap lines" });
    wrap.focus();
    await userEvent.keyboard("{Enter}");
    await expect(wrap).toHaveFocus();
    await expect(wrap).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: /^Copied$/ })).toBeVisible();
  },
};

export const Rich: Story = {
  ...Plain,
  decorators: [
    (Story, { globals }) => (
      <RichTopikContentProvider theme={globals.theme === "dark" ? "dark" : "light"}>
        <Story />
      </RichTopikContentProvider>
    ),
  ],
  play: async (context) => {
    await waitFor(() => expect(context.canvasElement.querySelector("pre.shiki")).toBeVisible(), {
      timeout: 10000,
    });
    await Plain.play?.(context);
  },
};

export const UnknownLanguage: Story = {
  ...Rich,
  args: { content: source.replace("```ts ", "```unavailable-topik-language ") },
  play: async (context) => {
    await Plain.play?.(context);
    await expect(context.canvasElement.querySelector("pre.shiki")).toBeNull();
  },
};

export const Dark: Story = { ...Rich, globals: { theme: "dark" } };

export const AlignedRows: Story = {
  args: { content: alignmentSource },
  play: async ({ canvasElement }) => {
    const rows = canvasElement.querySelectorAll<HTMLElement>("[data-line]");
    const text = [...rows].map((row) => row.querySelector<HTMLElement>(".topik-code-block__text")!);
    await expect(rows).toHaveLength(6);
    await expect(rows[0].querySelector(".topik-code-block__line-number")).toHaveTextContent("9998");
    await expect(rows[2].querySelector(".topik-code-block__line-number")).toHaveTextContent(
      "10000",
    );
    for (const element of text) {
      await expect(element.getBoundingClientRect().x).toBeCloseTo(
        text[0].getBoundingClientRect().x,
        2,
      );
    }
    await expect(rows[1]).toHaveAttribute("data-focused", "true");
    await expect(rows[2]).toHaveAttribute("data-diff", "added");
    await expect(rows[3]).toHaveAttribute("data-diff", "removed");
    await expect(rows[4]).toHaveAttribute("data-highlighted");
    await expect(rows[2].querySelector(".topik-code-block__sr-only")).toHaveTextContent(
      "Added line:",
    );
    await expect(rows[3].querySelector(".topik-code-block__sr-only")).toHaveTextContent(
      "Removed line:",
    );
    for (const row of [rows[1], rows[2], rows[3]]) {
      const decoration = getComputedStyle(row, "::before");
      await expect(decoration.position).toBe("absolute");
      await expect(decoration.borderInlineStartWidth).toBe("2px");
      if (matchMedia("(forced-colors: active)").matches) {
        await expect(decoration.borderInlineStartColor).toBe(getComputedStyle(row).color);
      }
    }

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(canvasElement.querySelector("pre")!);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      await expect(selection.toString()).toBe(alignmentPayload);
    } finally {
      selection.removeAllRanges();
    }
  },
};

export const RichAlignedRows: Story = {
  ...AlignedRows,
  decorators: Rich.decorators,
  play: async (context) => {
    await waitFor(() => expect(context.canvasElement.querySelector("pre.shiki")).toBeVisible(), {
      timeout: 10000,
    });
    await AlignedRows.play?.(context);
  },
};

export const OneLineHighlighting: Story = {
  args: {
    content: [
      "```ts\nconst values = [1, 2, 3, 4, 5, 6];\n```",
      '```ts\nconst { data, error } = await supabase.from("countries").select();\n```',
    ].join("\n\n"),
  },
  decorators: Rich.decorators,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll("pre.shiki")).toHaveLength(2), {
      timeout: 10000,
    });
    const blocks = canvasElement.querySelectorAll("pre.shiki");
    await expect(blocks[0]).toHaveTextContent("const values = [1, 2, 3, 4, 5, 6];");
    await expect(blocks[1]).toHaveTextContent(
      'const { data, error } = await supabase.from("countries").select();',
    );
    for (const block of blocks) {
      await expect(block.querySelectorAll("code span[style]").length).toBeGreaterThan(0);
      await expect(block.querySelectorAll("[data-line]")).toHaveLength(0);
    }
  },
};

export const WrapLongTokens: Story = {
  args: { content: longTokenSource },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: "100%", width: 420 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas, canvasElement, userEvent }) => {
    const blocks = canvasElement.querySelectorAll<HTMLElement>(".topik-code-block");
    await expect(blocks).toHaveLength(2);
    await expect(blocks[0].querySelectorAll("[data-line]")).toHaveLength(0);
    await expect(blocks[1].querySelectorAll("[data-line]")).toHaveLength(2);
    const wrapButtons = canvas.getAllByRole("button", { name: "Wrap lines" });
    const copyButtons = canvas.getAllByRole("button", { name: "Copy" });
    for (let index = 0; index < blocks.length; index++) {
      const pre = blocks[index].querySelector("pre")!;
      const initialHeight = pre.getBoundingClientRect().height;
      await expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
      await userEvent.click(wrapButtons[index]);
      await expect(wrapButtons[index]).toHaveAttribute("aria-pressed", "true");
      await expect(pre.scrollWidth).toBeLessThanOrEqual(pre.clientWidth);
      await expect(pre.getBoundingClientRect().height).toBeGreaterThan(initialHeight);
      const rowText = pre.querySelectorAll(".topik-code-block__text");
      const renderedText = rowText.length
        ? [...rowText].map((row) => row.textContent).join("")
        : pre.querySelector("code")!.textContent;
      await expect(renderedText).toBe(`${longTokenPayload}\n`);
      await userEvent.click(copyButtons[index]);
      await expect(writeClipboard).toHaveBeenLastCalledWith(`${longTokenPayload}\n`);
    }
  },
};

export const RichWrapLongTokens: Story = {
  ...WrapLongTokens,
  decorators: [
    ...(Array.isArray(Rich.decorators) ? Rich.decorators : [Rich.decorators!]),
    ...(Array.isArray(WrapLongTokens.decorators)
      ? WrapLongTokens.decorators
      : [WrapLongTokens.decorators!]),
  ],
  play: async (context) => {
    await waitFor(
      () => expect(context.canvasElement.querySelectorAll("pre.shiki")).toHaveLength(2),
      {
        timeout: 10000,
      },
    );
    await WrapLongTokens.play?.(context);
  },
};
