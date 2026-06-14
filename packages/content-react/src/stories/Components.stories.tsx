import type { Meta, StoryObj } from "@storybook/react-vite";
import { TopikContent } from "../theme/TopikContent";

const meta = {
  title: "Content React/Components",
  component: TopikContent,
} satisfies Meta<typeof TopikContent>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Callout: Story = {
  args: {
    content: '{% callout variant="warning" title="Watch out" %}Callout body.{% /callout %}',
  },
};

export const Cards: Story = {
  args: {
    content:
      '{% cardGrid columns=2 %}{% card title="Alpha" href="/alpha" icon="A" %}First card.{% /card %}{% card title="Beta" icon="B" %}Second card.{% /card %}{% /cardGrid %}',
  },
};

export const Accordion: Story = {
  args: {
    content: '{% accordion title="Details" open=true %}Accordion body.{% /accordion %}',
  },
};

export const Tabs: Story = {
  args: {
    content:
      '{% tabs %}{% tab title="One" %}First panel.{% /tab %}{% tab title="Two" %}Second panel.{% /tab %}{% /tabs %}',
  },
};

export const Steps: Story = {
  args: {
    content:
      '{% steps %}{% step title="Plan" %}Choose the topic.{% /step %}{% step title="Publish" %}Ship the lesson.{% /step %}{% /steps %}',
  },
};

export const FigureAndBadge: Story = {
  args: {
    content:
      'Status: {% badge variant="info" %}draft{% /badge %}\n\n{% figure src="asset:diagram" alt="Diagram" caption="Figure caption" /%}',
    resolveAsset: (id: string) => `https://placehold.co/800x360?text=${encodeURIComponent(id)}`,
  },
};

export const Quiz: Story = {
  args: {
    content:
      '{% quiz %}{% question type="multiple-choice" %}{% choice correct=true %}A{% /choice %}{% choice correct=true %}B{% /choice %}{% choice %}C{% /choice %}{% explanation %}A and B are correct.{% /explanation %}{% /question %}{% /quiz %}',
  },
};
