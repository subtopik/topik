import type { Meta, StoryObj } from "@storybook/react-vite";
import { TopikCallout } from "../theme/components";

const meta = {
  title: "Content React/Callout",
  component: TopikCallout,
  args: {
    title: "Keep in mind",
    children: "Content stays portable across your applications.",
    variant: "info",
  },
  argTypes: {
    title: { control: "text" },
    children: { control: "text" },
    variant: { control: "select", options: ["info", "tip", "warning", "danger"] },
  },
} satisfies Meta<typeof TopikCallout>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {};
export const Tip: Story = { args: { variant: "tip" } };
export const Warning: Story = { args: { variant: "warning" } };
export const Danger: Story = { args: { variant: "danger" } };
export const WithoutTitle: Story = { args: { title: undefined } };
export const LongContent: Story = {
  args: {
    title: "A longer heading that needs to wrap on small screens",
    children:
      "A callout can contain longer guidance. Check that its title and body remain readable when the viewport is narrow, without clipping text or overlapping the surrounding content.",
  },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const DarkVariants: Story = {
  globals: { theme: "dark" },
  render: (args) => (
    <>
      {["info", "tip", "warning", "danger"].map((variant) => (
        <TopikCallout {...args} key={variant} variant={variant} title={variant} />
      ))}
    </>
  ),
};
