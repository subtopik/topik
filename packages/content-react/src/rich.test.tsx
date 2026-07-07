import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getRichTopikComponents,
  RichTopikCodeBlock,
  RichTopikContentProvider,
  richTopikComponents,
} from "./rich";
import { TopikContent } from "./theme/TopikContent";

describe("rich content-react entry", () => {
  it("exposes rich renderer overrides on top of the default component map", () => {
    const components = getRichTopikComponents();

    expect(components.TopikCodeBlock).toBe(RichTopikCodeBlock);
    expect(components.TopikMath).toBe(richTopikComponents.TopikMath);
    expect(components.TopikLink).toBeDefined();
  });

  it("server-renders through the rich provider with fallback markup", () => {
    const html = renderToStaticMarkup(
      <RichTopikContentProvider>
        <TopikContent
          content={`\`\`\`ts
const answer = 42;
\`\`\`

{% math content="E = mc^2" /%}

\`\`\`mermaid
graph TD;
  A-->B;
\`\`\``}
        />
      </RichTopikContentProvider>,
    );

    expect(html).toContain("topik-rich-code-block");
    expect(html).toContain("topik-code-block");
    expect(html).toContain("topik-math");
    expect(html).toContain("topik-mermaid");
  });
});
