import type { Meta, StoryObj } from "@storybook/react-vite";
import { TopikContent } from "../theme/TopikContent";

const learningPage = `
# Building A Topic

Use {% badge variant="success" %}Topik{% /badge %} content to compose lessons.

{% callout variant="tip" title="Authoring model" %}
Content authors write Markdoc, while apps control rendering.
{% /callout %}

{% cardGrid columns=3 %}
{% card title="Concept" href="/concepts" icon="A" %}
Introduce the idea.
{% /card %}
{% card title="Practice" href="/practice" icon="B" %}
Apply the idea.
{% /card %}
{% card title="Review" href="/review" icon="C" %}
Check understanding.
{% /card %}
{% /cardGrid %}

{% tabs %}
{% tab title="Read" %}
Read the short explanation.
{% /tab %}
{% tab title="Try" %}
Complete the exercise.
{% /tab %}
{% /tabs %}

{% steps %}
{% step title="Install" %}
Run the setup command.
{% /step %}
{% step title="Write" %}
Create your first lesson.
{% /step %}
{% /steps %}

{% figure src="asset:diagram" alt="Lesson diagram" caption="Assets can be resolved by the host app." /%}

{% quiz %}
{% question type="single-choice" %}
{% choice correct=true %}
Topik content is rendered by the host app.
{% /choice %}
{% choice %}
Topik content requires consumer Tailwind setup.
{% /choice %}
{% explanation %}
The default theme ships compiled CSS.
{% /explanation %}
{% /question %}
{% /quiz %}
`;

const meta = {
  title: "Content React/TopikContent",
  component: TopikContent,
  args: {
    content: learningPage,
    resolveAsset: (id: string) => `https://placehold.co/960x420?text=${encodeURIComponent(id)}`,
  },
} satisfies Meta<typeof TopikContent>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LearningPage: Story = {};

export const InvalidDiagnostics: Story = {
  args: {
    content: "{% card /%}",
    onDiagnostic: (diagnostic) => console.warn(diagnostic.message),
  },
};

export const AssetResolution: Story = {
  args: {
    content: '{% figure src="asset:hero" darkSrc="asset:hero-dark" alt="Resolved asset" /%}',
    resolveAsset: (id: string) => `https://placehold.co/960x420?text=${encodeURIComponent(id)}`,
  },
};

export const ComponentOverride: Story = {
  args: {
    content: '{% callout title="Override" %}Rendered with a custom callout.{% /callout %}',
    components: {
      TopikCallout: ({ children }) => (
        <section style={{ border: "2px solid currentColor", padding: 16 }}>{children}</section>
      ),
    },
  },
};

export const DarkTheme: Story = {
  args: {
    content: learningPage,
    className: "storybook-dark",
  },
  decorators: [
    (Story) => (
      <div className="dark" style={{ background: "#101828", padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};
