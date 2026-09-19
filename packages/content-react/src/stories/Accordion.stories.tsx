import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { TopikAccordion } from "../theme/components";

const meta = {
  title: "Content React/Accordion",
  component: TopikAccordion,
  args: {
    title: "How is content rendered?",
    children: "The host application controls rendering.",
    open: false,
  },
  argTypes: {
    title: { control: "text" },
    children: { control: "text" },
    open: { control: "boolean" },
  },
} satisfies Meta<typeof TopikAccordion>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Open: Story = { args: { open: true } };
export const KeyboardToggle: Story = {
  play: async ({ canvas, userEvent }) => {
    const summary = canvas.getByText("How is content rendered?");
    await userEvent.click(summary);
    await expect(canvas.getByText("The host application controls rendering.")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("The host application controls rendering.")).not.toBeVisible();
  },
};
