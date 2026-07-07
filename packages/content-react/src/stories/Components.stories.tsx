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

export const Code: Story = {
  args: {
    content: [
      "{% codeGroup %}",
      '{% codeTab title="pnpm" icon="P" %}',
      "```sh",
      "pnpm add @topik/content-react",
      "```",
      "{% /codeTab %}",
      '{% codeTab title="npm" icon="N" %}',
      "```sh",
      "npm install @topik/content-react",
      "```",
      "{% /codeTab %}",
      "{% /codeGroup %}",
      "",
      "Use {% underline %}`TopikContent`{% /underline %} to render the compiled content.",
    ].join("\n"),
  },
};

export const MathAndMermaid: Story = {
  args: {
    content: [
      '{% math content="E = mc^2" /%}',
      "",
      'Inline math: {% mathInline content="x^2 + y^2 = z^2" /%}',
      "",
      "```mermaid",
      "graph TD;",
      "  Draft-->Validate;",
      "  Validate-->Render;",
      "```",
    ].join("\n"),
  },
};

export const TableAndImage: Story = {
  args: {
    content: [
      "![Resolved image](asset:diagram)",
      "",
      "| Feature | Default support | Rich support |",
      "| - | - | - |",
      "| Code | Semantic fallback | Shiki highlighting |",
      "| Math | Source fallback | KaTeX rendering |",
      "| Mermaid | Source fallback | SVG diagram |",
    ].join("\n"),
    resolveAsset: (id: string) => `https://placehold.co/920x360?text=${encodeURIComponent(id)}`,
  },
};

export const LinkNavigation: Story = {
  args: {
    content: "[Open internal route](/docs/getting-started)",
    onNavigateLink: (href) => {
      console.log("intercepted navigation", href);
      return true;
    },
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
