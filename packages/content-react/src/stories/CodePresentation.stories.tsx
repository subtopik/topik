import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, spyOn, waitFor } from "storybook/test";
import { RichTopikContentProvider } from "../rich";
import { TopikContent } from "../theme/TopikContent";
import "../rich/styles.css";

const payload = "\tconst answer = 42;  \n+source marker\n-source marker\n<tag>&amp;\n\n";
const source = [
  '```ts filename="client.ts" title="Client update" lines startLine=90 highlight="2,4" focus="2-4" collapse="3-6" wrap=false added="2" removed="3"',
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
  `\`\`\`ts lines wrap=false collapse="1"\n${longTokenPayload}\n\`\`\``,
].join("\n\n");
const methodPayload = [
  "class Example {",
  "  void first() {",
  "    prepare();",
  "    run();",
  "  }",
  "",
  "  void second() {",
  "    reset();",
  "    finish();",
  "  }",
  "}",
].join("\n");
const methodSource = [
  '```java filename="Example.java" lines collapse="3-4,8-9"',
  methodPayload,
  "```",
].join("\n");
const prefixSuffixPayload = [
  "prefix one",
  "prefix two",
  "visible first",
  "visible second",
  "suffix one",
  "suffix two",
].join("\n");
const prefixSuffixSource = ['```text lines collapse="1-2,5-6"', prefixSuffixPayload, "```"].join(
  "\n",
);
const changedMethodSource = [
  '```java filename="Example.java" lines startLine=90 collapse="2,10-11"',
  methodPayload,
  "```",
].join("\n");
const shortPayload = "class Short {\n  void run() {}\n}";
const shortSource = ['```java lines startLine=500 collapse="2"', shortPayload, "```"].join("\n");

function SwitchingSource() {
  const [content, setContent] = useState(methodSource);
  return (
    <>
      <button onClick={() => setContent(changedMethodSource)} type="button">
        Change fold ranges
      </button>
      <button onClick={() => setContent(shortSource)} type="button">
        Use short source
      </button>
      <TopikContent content={content} />
    </>
  );
}

function selectedCode(canvasElement: HTMLElement): string {
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(canvasElement.querySelector("pre")!);
  selection.removeAllRanges();
  selection.addRange(range);
  const text = selection.toString();
  selection.removeAllRanges();
  return text;
}

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

    const expand = canvas.getByRole("button", { name: "Show lines 92–95" });
    expand.focus();
    await userEvent.keyboard(" ");
    await expect(expand).toHaveFocus();
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    await expect(expand).toHaveAccessibleName("Hide lines 92–95");
    await expect(expand).toHaveAttribute("data-collapse-start", "3");
    await expect(expand).toHaveAttribute("data-collapse-end", "6");
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
    await expect(selectedCode(canvasElement)).toBe(payload);

    await userEvent.keyboard(" ");
    await expect(expand).toHaveFocus();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(rows[2]).not.toBeVisible();
    const selection = selectedCode(canvasElement);
    await expect(selection).toContain("const answer = 42;");
    await expect(selection).toContain("+source marker");
    await expect(selection).not.toContain("-source marker");
    await expect(selection).not.toContain("Show lines");
    await expect(selection).not.toContain("Hide lines");
    await expect(selection).not.toContain("Added line:");
    await expect(selection).not.toContain("Removed line:");

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

export const IndependentMethodFolds: Story = {
  args: { content: methodSource },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const rows = canvasElement.querySelectorAll<HTMLElement>("[data-line]");
    const first = canvas.getByRole("button", { name: "Show lines 3–4" });
    const second = canvas.getByRole("button", { name: "Show lines 8–9" });
    await expect(rows).toHaveLength(11);
    for (const index of [2, 3, 7, 8]) await expect(rows[index]).not.toBeVisible();
    for (const index of [0, 1, 4, 5, 6, 9, 10]) await expect(rows[index]).toBeVisible();
    for (const button of [first, second]) {
      await expect(button).toHaveAttribute("aria-expanded", "false");
      const region = document.getElementById(button.getAttribute("aria-controls")!);
      await expect(region).toHaveClass("topik-code-block__region");
      await expect(region).not.toBeVisible();
    }

    first.focus();
    await userEvent.keyboard("{Enter}");
    await expect(first).toHaveFocus();
    await expect(first).toHaveAccessibleName("Hide lines 3–4");
    await expect(rows[2]).toBeVisible();
    await expect(rows[7]).not.toBeVisible();
    await expect(second).toHaveAttribute("aria-expanded", "false");

    second.focus();
    await userEvent.keyboard(" ");
    await expect(second).toHaveFocus();
    await expect(second).toHaveAccessibleName("Hide lines 8–9");
    await expect(rows[7]).toBeVisible();
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await expect(selectedCode(canvasElement)).toBe(methodPayload);

    await userEvent.keyboard(" ");
    await expect(second).toHaveFocus();
    await expect(second).toHaveAttribute("aria-expanded", "false");
    await expect(rows[7]).not.toBeVisible();
    await expect(rows[2]).toBeVisible();
    const visibleSelection = selectedCode(canvasElement);
    await expect(visibleSelection).toContain("prepare();");
    await expect(visibleSelection).not.toContain("reset();");
    await expect(visibleSelection).not.toContain("Show lines");
    await expect(visibleSelection).not.toContain("Hide lines");

    await userEvent.click(canvas.getByRole("button", { name: "Copy" }));
    await expect(writeClipboard).toHaveBeenLastCalledWith(`${methodPayload}\n`);
  },
};

export const RichIndependentMethodFolds: Story = {
  ...IndependentMethodFolds,
  decorators: Rich.decorators,
  play: async (context) => {
    await waitFor(() => expect(context.canvasElement.querySelector("pre.shiki")).toBeVisible(), {
      timeout: 10000,
    });
    await IndependentMethodFolds.play?.(context);
  },
};

export const ChangedSourceResetsFolds: Story = {
  render: () => <SwitchingSource />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Show lines 3–4" }));
    await userEvent.click(canvas.getByRole("button", { name: "Wrap lines" }));
    await userEvent.click(canvas.getByRole("button", { name: "Copy" }));
    await expect(writeClipboard).toHaveBeenLastCalledWith(`${methodPayload}\n`);

    await userEvent.click(canvas.getByRole("button", { name: "Change fold ranges" }));
    let rows = canvasElement.querySelectorAll("[data-line]");
    await expect(rows).toHaveLength(11);
    for (const index of [1, 9, 10]) await expect(rows[index]).not.toBeVisible();
    for (const index of [0, 2, 3, 4, 5, 6, 7, 8]) await expect(rows[index]).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Show line 91" })).toHaveAttribute(
      "data-collapse-start",
      "2",
    );
    await expect(canvas.getByRole("button", { name: "Show lines 99–100" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(canvas.getByRole("button", { name: "Wrap lines" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(canvas.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(rows[0].querySelector(".topik-code-block__line-number")).toHaveTextContent("90");
    await userEvent.click(canvas.getByRole("button", { name: "Show line 91" }));
    await userEvent.click(canvas.getByRole("button", { name: "Copy" }));
    await expect(writeClipboard).toHaveBeenLastCalledWith(`${methodPayload}\n`);

    await userEvent.click(canvas.getByRole("button", { name: "Use short source" }));
    rows = canvasElement.querySelectorAll("[data-line]");
    await expect(rows).toHaveLength(3);
    await expect(rows[0]).toBeVisible();
    await expect(rows[1]).not.toBeVisible();
    await expect(rows[2]).toBeVisible();
    await expect(rows[0].querySelector(".topik-code-block__line-number")).toHaveTextContent("500");
    await expect(canvasElement.querySelector("pre")).not.toHaveTextContent("prepare();");
    const fold = canvas.getByRole("button", { name: "Show line 501" });
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(canvas.getByRole("button", { name: "Copy" }));
    await expect(writeClipboard).toHaveBeenLastCalledWith(`${shortPayload}\n`);
    await userEvent.click(fold);
    await expect(fold).toHaveFocus();
    await expect(fold).toHaveAccessibleName("Hide line 501");
    await expect(selectedCode(canvasElement)).toBe(shortPayload);
  },
};

export const RichChangedSourceResetsFolds: Story = {
  ...ChangedSourceResetsFolds,
  decorators: Rich.decorators,
  play: async (context) => {
    await waitFor(() => expect(context.canvasElement.querySelector("pre.shiki")).toBeVisible(), {
      timeout: 10000,
    });
    await ChangedSourceResetsFolds.play?.(context);
    await waitFor(() => expect(context.canvasElement.querySelector("pre.shiki")).toBeVisible(), {
      timeout: 10000,
    });
    await expect(context.canvasElement.querySelector("pre.shiki")).toHaveTextContent("class Short");
  },
};

export const PrefixAndSuffixFolds: Story = {
  args: { content: prefixSuffixSource },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const rows = canvasElement.querySelectorAll<HTMLElement>("[data-line]");
    const prefix = canvas.getByRole("button", { name: "Show lines 1–2" });
    const suffix = canvas.getByRole("button", { name: "Show lines 5–6" });
    await expect(rows).toHaveLength(6);
    for (const index of [0, 1, 4, 5]) await expect(rows[index]).not.toBeVisible();
    await expect(rows[2]).toBeVisible();
    await expect(rows[3]).toBeVisible();
    const selection = selectedCode(canvasElement);
    await expect(selection).toContain("visible first\nvisible second");
    await expect(selection).not.toContain("prefix");
    await expect(selection).not.toContain("suffix");
    await expect(selection).not.toContain("Show lines");
    await expect(selection).not.toContain("Hide lines");

    await userEvent.click(suffix);
    await expect(rows[4]).toBeVisible();
    await expect(rows[0]).not.toBeVisible();
    await userEvent.click(prefix);
    await expect(rows[0]).toBeVisible();
    await expect(selectedCode(canvasElement)).toBe(prefixSuffixPayload);
    await userEvent.click(prefix);
    await expect(prefix).toHaveFocus();
    await expect(rows[0]).not.toBeVisible();
    await expect(rows[4]).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Copy" }));
    await expect(writeClipboard).toHaveBeenLastCalledWith(`${prefixSuffixPayload}\n`);
  },
};

export const SingleLineAndWholeBlockFolds: Story = {
  args: {
    content: [
      '```ts lines collapse="2"\nconst first = 1;\nconst middle = 2;\nconst last = 3;\n```',
      '```ts startLine=90 collapse="1-3"\nconst one = 1;\nconst two = 2;\nconst three = 3;\n```',
    ].join("\n\n"),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const blocks = canvasElement.querySelectorAll(".topik-code-block");
    const single = canvas.getByRole("button", { name: "Show line 2" });
    const whole = canvas.getByRole("button", { name: "Show lines 1–3" });
    const singleRows = blocks[0].querySelectorAll("[data-line]");
    const wholeRows = blocks[1].querySelectorAll("[data-line]");
    await expect(singleRows[0]).toBeVisible();
    await expect(singleRows[1]).not.toBeVisible();
    await expect(singleRows[2]).toBeVisible();
    for (const row of wholeRows) await expect(row).not.toBeVisible();
    await userEvent.click(single);
    await expect(single).toHaveAccessibleName("Hide line 2");
    await expect(singleRows[1]).toBeVisible();
    await userEvent.click(whole);
    await expect(whole).toHaveAccessibleName("Hide lines 1–3");
    for (const row of wholeRows) await expect(row).toBeVisible();
    await userEvent.click(single);
    await expect(single).toHaveFocus();
    await expect(singleRows[1]).not.toBeVisible();
    for (const row of wholeRows) await expect(row).toBeVisible();
    await userEvent.click(whole);
    await expect(whole).toHaveFocus();
    for (const row of wholeRows) await expect(row).not.toBeVisible();
    await userEvent.click(canvas.getAllByRole("button", { name: "Copy" })[1]);
    await expect(writeClipboard).toHaveBeenLastCalledWith(
      "const one = 1;\nconst two = 2;\nconst three = 3;\n",
    );
  },
};

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
    const fold = canvas.getByRole("button", { name: "Show line 1" });
    await userEvent.click(fold);
    await expect(fold).toHaveAttribute("aria-expanded", "true");
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
    await userEvent.click(fold);
    await expect(fold).toHaveFocus();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(blocks[1].querySelectorAll("[data-line]")[0]).not.toBeVisible();
    await expect(blocks[1].querySelectorAll("[data-line]")[1]).toBeVisible();
    await expect(wrapButtons[1]).toHaveAttribute("aria-pressed", "true");
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
