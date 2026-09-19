import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { TopikChoice, TopikExplanation, TopikQuestion, TopikQuiz } from "../theme/components";

const meta = {
  title: "Content React/Quiz",
  component: TopikQuestion,
  args: { type: "single-choice" },
  argTypes: { type: { control: "select", options: ["single-choice", "multiple-choice"] } },
  render: (args) => (
    <TopikQuiz>
      <p>Where can you render Topik content?</p>
      <TopikQuestion key={String(args.type)} {...args}>
        <TopikChoice correct>In your own application</TopikChoice>
        <TopikChoice correct={args.type === "multiple-choice"}>
          {args.type === "multiple-choice"
            ? "On a documentation site"
            : "Only on a hosted course platform"}
        </TopikChoice>
        <TopikChoice>Only in the editor</TopikChoice>
        <TopikExplanation>
          Your host application controls how content is presented.
        </TopikExplanation>
      </TopikQuestion>
    </TopikQuiz>
  ),
} satisfies Meta<typeof TopikQuestion>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unanswered: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toBeEmptyDOMElement();
  },
};
export const IncorrectAnswer: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("radio", { name: "Only in the editor" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Try again");
    await expect(canvas.getByRole("status")).toBeVisible();
    await expect(
      canvas.getByText("Your host application controls how content is presented."),
    ).toBeVisible();
  },
};
export const CorrectAnswer: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("radio", { name: "Only in the editor" }));
    await userEvent.click(canvas.getByRole("radio", { name: "In your own application" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Correct");
    await expect(canvas.getByRole("status")).toBeVisible();
    await expect(canvas.getByRole("radio", { name: "Only in the editor" })).not.toBeChecked();
  },
};
export const MultipleChoice: Story = {
  args: { type: "multiple-choice" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("checkbox", { name: "In your own application" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Try again");
    await userEvent.click(canvas.getByRole("checkbox", { name: "On a documentation site" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Correct");
    await expect(canvas.getByRole("status")).toBeVisible();
  },
};
