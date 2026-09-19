import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { TopikTab, TopikTabs } from "../theme/components";

const meta = {
  title: "Content React/Tabs",
  component: TopikTabs,
  render: () => (
    <TopikTabs>
      <TopikTab title="Write">Write your content in Markdoc.</TopikTab>
      <TopikTab title="Preview">Preview it in your application.</TopikTab>
      <TopikTab title="Publish">Publish when you are ready.</TopikTab>
    </TopikTabs>
  ),
} satisfies Meta<typeof TopikTabs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const SecondPanel: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("tab", { name: "Preview" }));
    await expect(canvas.getByRole("tabpanel")).toHaveTextContent("Preview it in your application.");
  },
};
export const KeyboardNavigation: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("tab", { name: "Write" }));
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "Preview" })).toHaveFocus();
    await expect(canvas.getByRole("tab", { name: "Preview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{End}");
    await expect(canvas.getByRole("tab", { name: "Publish" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "Write" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(canvas.getByRole("tab", { name: "Publish" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect(canvas.getByRole("tabpanel")).toHaveTextContent("Write your content in Markdoc.");
  },
};
