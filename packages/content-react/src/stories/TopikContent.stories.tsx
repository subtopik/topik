import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { TopikContent } from "../theme/TopikContent";
import { diagramAssetName, heroAssetName, darkHeroAssetName, resolveStoryAsset } from "./fixtures";

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
    resolveAsset: resolveStoryAsset,
  },
  argTypes: {
    content: { control: "text", description: "Validated Topik Markdoc source." },
    colorScheme: { control: "select", options: [undefined, "light", "dark"] },
    components: { control: false },
    config: { control: false },
    resolveAsset: { control: false },
    invalidContentPlaceholder: { control: false },
  },
  parameters: {
    docs: {
      description: {
        component:
          'The themed renderer validates Markdoc before rendering it. Import @topik/content-react/theme/styles.css in your app. Invalid content throws by default; select invalidContent="placeholder" to show a safe alert. The Theme toolbar also controls light/dark asset selection.',
      },
    },
  },
} satisfies Meta<typeof TopikContent>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LearningPage: Story = {};

export const InvalidDiagnostics: Story = {
  args: {
    content: "{% card /%}",
    invalidContent: "placeholder",
    onDiagnostic: fn(),
  },
  play: async ({ args, canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Unsupported or invalid Topik content",
    );
    await expect(args.onDiagnostic).toHaveBeenCalled();
  },
};

export const AssetResolution: Story = {
  args: {
    content: `{% figure src="asset:${heroAssetName}" darkSrc="asset:${darkHeroAssetName}" alt="Compiled Asset" /%}`,
    resolveAsset: resolveStoryAsset,
  },
  play: async ({ canvas, globals }) => {
    const image = canvas.getByRole("img", { name: "Compiled Asset" });
    await expect(image).toHaveAttribute(
      "src",
      `/storybook-assets/hero-${globals.theme === "dark" ? "dark" : "light"}.svg`,
    );
  },
};

export const DarkAssetResolution: Story = {
  ...AssetResolution,
  globals: { theme: "dark" },
};

export const MissingAsset: Story = {
  args: {
    content: `{% figure src="asset:${heroAssetName}" alt="Unavailable image" caption="The host could not resolve this asset." /%}`,
    resolveAsset: () => undefined,
    onAssetDiagnostic: fn(),
  },
  play: async ({ args }) => {
    await expect(args.onAssetDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MISSING" }),
    );
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
  globals: { theme: "dark" },
};

export const MobilePage: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
