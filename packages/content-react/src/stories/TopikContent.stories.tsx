import type { Meta, StoryObj } from "@storybook/react-vite";
import { TopikContent } from "../theme/TopikContent";

const diagramAssetName = "auto-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const heroAssetName = "auto-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const darkHeroAssetName = "auto-v1-cccccccccccccccccccccccccccccccccccccccccccccccccccc";

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

{% figure src="asset:${diagramAssetName}" alt="Lesson diagram" caption="Compiled Asset resolved by the host." /%}

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
    resolveAsset: (name: string) => `https://placehold.co/960x420?text=${encodeURIComponent(name)}`,
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
    content: `{% figure src="asset:${heroAssetName}" darkSrc="asset:${darkHeroAssetName}" alt="Compiled Asset" /%}`,
    resolveAsset: (name: string) => `https://placehold.co/960x420?text=${encodeURIComponent(name)}`,
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
