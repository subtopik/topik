import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn } from "storybook/test";
import { TopikContent } from "../theme/TopikContent";
import { diagramAssetName, heroAssetName, darkHeroAssetName, resolveStoryAsset } from "./fixtures";

const learningPage = `
# Building A Topic

Use {% badge variant="success" %}Topik{% /badge %} content to compose lessons.

{% callout variant="tip" title="Authoring model" %}
Content authors write Topik Markdown, while apps control rendering.
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
    content: { control: "text", description: "Validated Topik Markdown source." },
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
          'The themed renderer validates Topik Markdown before rendering it. Import @topik/content-react/theme/styles.css in your app. Invalid content throws by default; select invalidContent="placeholder" to show a safe alert. The Theme toolbar also controls light/dark asset selection.',
      },
    },
  },
} satisfies Meta<typeof TopikContent>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LearningPage: Story = {};

export const QuizExplanation: Story = {
  args: {
    content: `{% quiz %}
{% question %}
{% choice correct=true %}
Yes
{% /choice %}
{% choice %}
No
{% /choice %}
{% explanation %}
Because yes.
{% /explanation %}
{% /question %}
{% /quiz %}`,
  },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.queryByText("Because yes.")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("radio", { name: "No" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Try again");
    await expect(canvas.getByText("Because yes.")).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: "Yes" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Correct");
    await expect(canvas.getByText("Because yes.")).toBeVisible();
  },
};

export const CustomQuizExplanation: Story = {
  ...QuizExplanation,
  args: {
    ...QuizExplanation.args,
    components: {
      TopikChoice: ({ children }) => <strong>{children}</strong>,
      TopikExplanation: ({ children }) => <aside aria-label="Explanation">{children}</aside>,
    },
  },
};

function resizableTabsStory(group: "tabs" | "codeGroup", childTag: "tab" | "codeTab"): Story {
  return {
    render: function ResizableTabs(args) {
      const [count, setCount] = useState(3);
      const content = [
        `{% ${group} %}`,
        ...["First", "Second", "Third"]
          .slice(0, count)
          .flatMap((title) => [
            `{% ${childTag} title="${title}" %}`,
            "```text",
            `${title} panel`,
            "```",
            `{% /${childTag} %}`,
          ]),
        `{% /${group} %}`,
      ].join("\n");
      return (
        <>
          <button type="button" onClick={() => setCount(2)}>
            Show two tabs
          </button>
          <button type="button" onClick={() => setCount(3)}>
            Show three tabs
          </button>
          <TopikContent {...args} content={content} />
        </>
      );
    },
    play: async ({ canvas, userEvent }) => {
      await userEvent.click(canvas.getByRole("tab", { name: "Third" }));
      await expect(canvas.getByRole("tabpanel")).toHaveTextContent("Third panel");
      await userEvent.click(canvas.getByRole("button", { name: "Show two tabs" }));
      await expect(canvas.getAllByRole("tab")).toHaveLength(2);
      await expect(canvas.getByRole("tab", { name: "Second" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(canvas.getByRole("tab", { name: "Second" })).toHaveAttribute("tabindex", "0");
      await expect(canvas.getByRole("tabpanel")).toHaveTextContent("Second panel");
      await expect(canvas.getByRole("button", { name: "Show two tabs" })).toHaveFocus();
      await userEvent.click(canvas.getByRole("button", { name: "Show three tabs" }));
      await expect(canvas.getAllByRole("tab")).toHaveLength(3);
      await expect(canvas.getByRole("tabpanel")).toHaveTextContent("Second panel");
      await userEvent.click(canvas.getByRole("button", { name: "Show two tabs" }));
      await userEvent.click(canvas.getByRole("tab", { name: "Second" }));
      for (const [key, title] of [
        ["{ArrowRight}", "First"],
        ["{ArrowLeft}", "Second"],
        ["{Home}", "First"],
        ["{End}", "Second"],
      ]) {
        await userEvent.keyboard(key);
        await expect(canvas.getByRole("tab", { name: title })).toHaveFocus();
        await expect(canvas.getByRole("tab", { name: title })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(canvas.getByRole("tabpanel")).toHaveTextContent(`${title} panel`);
      }
    },
  };
}

export const ShrinkingTabs: Story = resizableTabsStory("tabs", "tab");
export const ShrinkingCodeGroup: Story = resizableTabsStory("codeGroup", "codeTab");

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
  play: async ({ args, canvas }) => {
    await expect(args.onAssetDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MISSING" }),
    );
    // The text alternative and caption stay readable without the image.
    await expect(canvas.getByText("Unavailable image")).toBeVisible();
    await expect(canvas.getByText("The host could not resolve this asset.")).toBeVisible();
  },
};

export const ComponentOverride: Story = {
  args: {
    content: `{% callout title="Override" %}
Rendered with a custom callout.
{% /callout %}`,
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

/** An explicit scheme paints its own canvas, so dark content stays readable on a light page. */
export const ExplicitDarkOnLightPage: Story = {
  args: { colorScheme: "dark" },
  globals: { theme: "light" },
  play: async ({ canvasElement }) => {
    const content = canvasElement.querySelector<HTMLElement>('.topik-content[data-theme="dark"]');
    await expect(content).not.toBeNull();
    await expect(getComputedStyle(content!).backgroundColor).toBe("rgb(16, 24, 40)");
  },
};

const rightToLeftPage = `
{% callout variant="tip" title="تلميح" %}
يكتب المؤلفون المحتوى ويعرضه التطبيق.
{% /callout %}

{% steps %}
{% step title="التثبيت" %}
شغّل أمر الإعداد.
{% /step %}
{% step title="الكتابة" %}
أنشئ أول درس.
{% /step %}
{% /steps %}

{% tabs %}
{% tab title="اقرأ" %}
اقرأ الشرح القصير.
{% /tab %}
{% tab title="جرّب" %}
أكمل التمرين.
{% /tab %}
{% /tabs %}

{% codeGroup %}
{% codeTab title="pnpm" %}
\`\`\`sh
pnpm add @topik/content-react
\`\`\`
{% /codeTab %}
{% codeTab title="npm" %}
\`\`\`sh
npm install @topik/content-react
\`\`\`
{% /codeTab %}
{% /codeGroup %}

{% math content="E = mc^2" /%}
`;

/** Layout mirrors in right-to-left text while code and math source stay left to right. */
export const RightToLeft: Story = {
  args: { content: rightToLeftPage },
  decorators: [
    (Story) => (
      <div dir="rtl" lang="ar">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas, canvasElement, userEvent }) => {
    const step = canvasElement.querySelector<HTMLElement>(".topik-step")!;
    const stepStyle = getComputedStyle(step);
    await expect(stepStyle.borderRightWidth).toBe("2px");
    await expect(stepStyle.borderLeftWidth).toBe("0px");
    await expect(stepStyle.paddingLeft).toBe("0px");
    await expect(parseFloat(stepStyle.paddingRight)).toBeGreaterThan(0);
    // The number badge sits over the rail on the inline-start (right) edge.
    const badge = getComputedStyle(step, "::before");
    await expect(parseFloat(badge.right)).toBeLessThan(0);
    await expect(parseFloat(badge.left)).toBeGreaterThan(0);
    const callout = getComputedStyle(canvasElement.querySelector(".topik-callout")!);
    await expect(callout.borderRightWidth).toBe("3px");
    for (const pre of canvasElement.querySelectorAll("pre")) {
      await expect(getComputedStyle(pre).direction).toBe("ltr");
      await expect(getComputedStyle(pre).textAlign).toBe("left");
    }
    // ArrowLeft moves to the next tab, which sits to the left in right-to-left layouts.
    await userEvent.click(canvas.getByRole("tab", { name: "اقرأ" }));
    await userEvent.keyboard("{ArrowLeft}");
    await expect(canvas.getByRole("tab", { name: "جرّب" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "اقرأ" })).toHaveFocus();
  },
};

export const MobilePage: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
