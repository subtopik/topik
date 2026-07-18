// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TopikContentProvider } from "../core/context";
import type { TopikLinkRenderProps } from "../core/components";
import {
  TopikAccordion,
  TopikBadge,
  TopikCallout,
  TopikCard,
  TopikCardGrid,
  TopikCodeBlock,
  TopikCodeGroup,
  TopikCodeTab,
  TopikChoice,
  TopikExplanation,
  TopikFigure,
  TopikImage,
  TopikInlineCode,
  TopikLink,
  TopikMath,
  TopikMathInline,
  TopikMermaid,
  TopikQuestion,
  TopikQuiz,
  TopikStep,
  TopikSteps,
  TopikTab,
  TopikTabs,
  TopikTable,
  TopikTableCell,
  TopikTableHeader,
  TopikTableRow,
  TopikUnderline,
} from "./components";

const contentReactRoot = existsSync(resolve(process.cwd(), "src/theme/styles.css"))
  ? process.cwd()
  : resolve(process.cwd(), "packages/content-react");
const themeStyles = readFileSync(resolve(contentReactRoot, "src/theme/styles.css"), "utf8");
const richStyles = readFileSync(resolve(contentReactRoot, "src/rich/styles.css"), "utf8");

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (!root) return;
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(element: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe("default Topik theme components", () => {
  it("renders callout variants and optional titles", () => {
    const titled = renderToStaticMarkup(
      <TopikCallout title="Heads up" variant="warning">
        Body
      </TopikCallout>,
    );
    const untitled = renderToStaticMarkup(<TopikCallout>Body</TopikCallout>);

    expect(titled).toContain('class="topik-callout not-prose"');
    expect(titled).toContain('data-variant="warning"');
    expect(titled).toContain('<div class="topik-callout__title"><strong>Heads up</strong></div>');
    expect(titled).toContain("Heads up");
    expect(untitled).toContain('data-variant="info"');
    expect(untitled).not.toContain("topik-callout__title");
  });

  it("ships theme styles in the components cascade layer", () => {
    expect(themeStyles.trimStart()).toMatch(/^@layer components\s*\{/);
    expect(themeStyles).toContain(".topik-callout__body > :last-child");
    expect(richStyles.trimStart()).toMatch(/^@layer components\s*\{/);
  });

  it("renders card grids and cards with link, icon, title, and body slots", () => {
    const linked = renderToStaticMarkup(
      <TopikCardGrid columns={2}>
        <TopikCard
          href="/start"
          icon="S"
          resolveLink={(href: string) => `/preview${href}`}
          title="Start"
        >
          Open the guide.
        </TopikCard>
      </TopikCardGrid>,
    );
    const plain = renderToStaticMarkup(<TopikCard title="Plain">No link.</TopikCard>);

    expect(linked).toContain("topik-card-grid");
    expect(linked).toContain("--topik-card-grid-columns:2");
    expect(linked).toContain('<a class="topik-card" href="/preview/start">');
    expect(linked).toContain("topik-card__icon");
    expect(linked).toContain("Open the guide.");
    expect(plain).toContain('<div class="topik-card">');
  });

  it("renders accordion open state and summary/body regions", () => {
    const html = renderToStaticMarkup(
      <TopikAccordion open title="Details">
        More information.
      </TopikAccordion>,
    );

    expect(html).toContain("<details");
    expect(html).toContain('open=""');
    expect(html).toContain("topik-accordion__summary");
    expect(html).toContain("Details");
    expect(html).toContain("More information.");
  });

  it("renders code blocks, inline code, and code groups", () => {
    const block = renderToStaticMarkup(
      <TopikCodeBlock content="const answer = 42;" language="ts" />,
    );
    const inline = renderToStaticMarkup(<TopikInlineCode>value</TopikInlineCode>);
    const group = renderToStaticMarkup(
      <TopikCodeGroup>
        <TopikCodeTab icon="P" title="pnpm">
          <TopikCodeBlock content="pnpm install" language="sh" />
        </TopikCodeTab>
      </TopikCodeGroup>,
    );

    expect(block).toContain('class="topik-code-block"');
    expect(block).toContain('data-language="ts"');
    expect(block).toContain("const answer = 42;");
    expect(inline).toContain("<code>value</code>");
    expect(group).toContain("topik-code-group");
    expect(group).toContain('role="tablist"');
    expect(group).toContain("pnpm");
  });

  it("supports keyboard navigation across code group tabs", () => {
    const dom = mount(
      <TopikCodeGroup>
        <TopikCodeTab title="pnpm">
          <TopikCodeBlock content="pnpm install" language="sh" />
        </TopikCodeTab>
        <TopikCodeTab title="npm">
          <TopikCodeBlock content="npm install" language="sh" />
        </TopikCodeTab>
      </TopikCodeGroup>,
    );

    const tabs = dom.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const panels = dom.querySelectorAll<HTMLElement>('[role="tabpanel"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(panels[0].hidden).toBe(false);
    expect(panels[1].hidden).toBe(true);

    act(() => {
      tabs[0].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(panels[0].hidden).toBe(true);
    expect(panels[1].hidden).toBe(false);
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("renders tabs with accessible tablist markup and switches panels", () => {
    const dom = mount(
      <TopikTabs>
        <TopikTab title="First">Alpha</TopikTab>
        <TopikTab title="Second">Beta</TopikTab>
      </TopikTabs>,
    );

    const tabs = dom.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const panels = dom.querySelectorAll<HTMLElement>('[role="tabpanel"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(panels[0].hidden).toBe(false);
    expect(panels[1].hidden).toBe(true);

    act(() => tabs[1].click());

    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(panels[0].hidden).toBe(true);
    expect(panels[1].hidden).toBe(false);
    expect(panels[1].textContent).toContain("Beta");
  });

  it("supports keyboard navigation across tabs", () => {
    const dom = mount(
      <TopikTabs>
        <TopikTab title="First">Alpha</TopikTab>
        <TopikTab title="Second">Beta</TopikTab>
        <TopikTab title="Third">Gamma</TopikTab>
      </TopikTabs>,
    );

    const tabs = dom.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].tabIndex).toBe(-1);

    act(() => {
      tabs[0].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].tabIndex).toBe(0);
    expect(document.activeElement).toBe(tabs[1]);

    act(() => {
      tabs[1].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
    });

    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[2]);

    act(() => {
      tabs[2].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
    });

    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("renders ordered steps with optional titles", () => {
    const html = renderToStaticMarkup(
      <TopikSteps>
        <TopikStep title="Install">Run setup.</TopikStep>
        <TopikStep>Publish.</TopikStep>
      </TopikSteps>,
    );

    expect(html).toContain('<ol class="topik-steps">');
    expect(html).toContain("topik-step__title");
    expect(html).toContain("Install");
    expect(html).toContain("Run setup.");
    expect(html).toContain("Publish.");
  });

  it("renders figures with light source, dark source, alt text, and caption", () => {
    const html = renderToStaticMarkup(
      <TopikFigure
        alt="Architecture"
        caption="System diagram"
        darkSrc="/dark.png"
        src="/light.png"
      />,
    );

    expect(html).toContain('<figure class="topik-figure">');
    expect(html).toContain('media="(prefers-color-scheme: dark)"');
    expect(html).toContain('srcSet="/dark.png"');
    expect(html).toContain('alt="Architecture"');
    expect(html).toContain('src="/light.png"');
    expect(html).toContain("<figcaption>System diagram</figcaption>");
  });

  it("uses an explicit color scheme instead of the browser preference", () => {
    const lightHtml = renderToStaticMarkup(
      <TopikFigure colorScheme="light" darkSrc="/dark.png" src="/light.png" />,
    );
    const darkHtml = renderToStaticMarkup(
      <TopikFigure colorScheme="dark" darkSrc="/dark.png" src="/light.png" />,
    );

    expect(lightHtml).toContain('src="/light.png"');
    expect(lightHtml).not.toContain("prefers-color-scheme");
    expect(darkHtml).toContain('src="/dark.png"');
    expect(darkHtml).not.toContain("prefers-color-scheme");
  });

  it("renders images, math, mermaid, and tables", () => {
    const image = renderToStaticMarkup(
      <TopikImage alt="Logo" src="/logo.svg" title="Logo title" />,
    );
    const math = renderToStaticMarkup(<TopikMath content="E = mc^2" />);
    const inlineMath = renderToStaticMarkup(<TopikMathInline content="x^2" />);
    const mermaid = renderToStaticMarkup(<TopikMermaid content="graph TD; A-->B;" />);
    const table = renderToStaticMarkup(
      <TopikTable>
        <tbody>
          <TopikTableRow>
            <TopikTableHeader align="center" width="40%">
              Head
            </TopikTableHeader>
            <TopikTableCell align="right">Cell</TopikTableCell>
          </TopikTableRow>
        </tbody>
      </TopikTable>,
    );

    expect(image).toContain('class="topik-image"');
    expect(image).toContain('src="/logo.svg"');
    expect(math).toContain('class="topik-math"');
    expect(inlineMath).toContain('class="topik-math-inline"');
    expect(mermaid).toContain('class="topik-mermaid"');
    expect(table).toContain('class="topik-table"');
    expect(table).toContain('style="text-align:center;width:40%"');
    expect(table).toContain('style="text-align:right"');
  });

  it("intercepts link navigation through explicit props and provider context", () => {
    const handled: string[] = [];
    const explicitDom = mount(
      <TopikLink
        href="/explicit"
        onNavigateLink={(href: string) => handled.push(href) === 1}
        resolveLink={(href: string) => `/preview${href}`}
      >
        Explicit
      </TopikLink>,
    );
    const explicitLink = explicitDom.querySelector<HTMLAnchorElement>("a");

    act(() => explicitLink?.click());

    expect(handled).toContain("/explicit");
    expect(explicitLink?.getAttribute("href")).toBe("/preview/explicit");

    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;

    const providerDom = mount(
      <TopikContentProvider
        onNavigateLink={(href) => handled.push(href) === 2}
        renderLink={(props: TopikLinkRenderProps) => <a {...props} data-provider-link />}
        resolveLink={(href) => `/provider-preview${href}`}
      >
        <TopikLink href="/provider">Provider</TopikLink>
      </TopikContentProvider>,
    );
    const providerLink = providerDom.querySelector<HTMLAnchorElement>("a");

    act(() => providerLink?.click());

    expect(handled).toContain("/provider");
    expect(providerLink?.getAttribute("href")).toBe("/provider-preview/provider");
    expect(providerLink?.hasAttribute("data-provider-link")).toBe(true);
  });

  it("intercepts card navigation through explicit props and provider context", () => {
    const handled: string[] = [];
    const explicitDom = mount(
      <TopikCard
        href="/explicit-card"
        onNavigateLink={(href: string) => handled.push(href) === 1}
        resolveLink={(href: string) => `/preview${href}`}
        title="Explicit card"
      />,
    );

    act(() => explicitDom.querySelector<HTMLAnchorElement>("a")?.click());
    expect(handled).toContain("/explicit-card");
    expect(explicitDom.querySelector("a")?.getAttribute("href")).toBe("/preview/explicit-card");

    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;

    const providerDom = mount(
      <TopikContentProvider
        onNavigateLink={(href) => handled.push(href) === 2}
        renderLink={(props: TopikLinkRenderProps) => <a {...props} data-provider-link />}
        resolveLink={(href) => `/provider-preview${href}`}
      >
        <TopikCard href="/provider-card" title="Provider card" />
      </TopikContentProvider>,
    );

    act(() => providerDom.querySelector<HTMLAnchorElement>("a")?.click());
    expect(handled).toContain("/provider-card");
    expect(providerDom.querySelector("a")?.getAttribute("href")).toBe(
      "/provider-preview/provider-card",
    );
    expect(providerDom.querySelector("a")?.hasAttribute("data-provider-link")).toBe(true);
  });

  it("renders unsafe link targets as non-interactive content", () => {
    const calls: string[] = [];
    const unsafeLink = renderToStaticMarkup(
      <TopikLink
        href="javascript:alert(document.domain)"
        onNavigateLink={() => {
          calls.push("navigate");
        }}
        renderLink={() => {
          calls.push("render");
          return <a href="/unexpected">Unsafe</a>;
        }}
        resolveLink={() => {
          calls.push("resolve");
          return "/safe";
        }}
      >
        Unsafe link
      </TopikLink>,
    );

    expect(unsafeLink).toBe("Unsafe link");
    expect(calls).toEqual([]);

    const unsafeCard = renderToStaticMarkup(
      <TopikCard href="data:text/html,unsafe" title="Unsafe card">
        Body
      </TopikCard>,
    );

    expect(unsafeCard).toContain('<div class="topik-card">');
    expect(unsafeCard).not.toContain("href=");
  });

  it("rejects unsafe link resolver output before rendering or navigation", () => {
    const calls: string[] = [];
    const html = renderToStaticMarkup(
      <TopikLink
        href="/safe"
        onNavigateLink={() => {
          calls.push("navigate");
        }}
        renderLink={() => {
          calls.push("render");
          return <a href="/unexpected">Unexpected</a>;
        }}
        resolveLink={() => "java\nscript:alert(1)"}
      >
        Safe label
      </TopikLink>,
    );

    expect(html).toBe("Safe label");
    expect(calls).toEqual([]);

    const card = renderToStaticMarkup(
      <TopikCard href="/safe" resolveLink={() => "javascript:alert(1)"} title="Safe card" />,
    );
    expect(card).toContain('<div class="topik-card">');
    expect(card).not.toContain("href=");
  });

  it("renders badge variants and defaults", () => {
    const success = renderToStaticMarkup(<TopikBadge variant="success">Stable</TopikBadge>);
    const neutral = renderToStaticMarkup(<TopikBadge>Draft</TopikBadge>);
    const underline = renderToStaticMarkup(<TopikUnderline>Important</TopikUnderline>);

    expect(success).toContain('class="topik-badge"');
    expect(success).toContain('data-variant="success"');
    expect(neutral).toContain('data-variant="neutral"');
    expect(underline).toContain("<u>Important</u>");
  });

  it("renders quiz containers", () => {
    const html = renderToStaticMarkup(
      <TopikQuiz>
        <TopikQuestion>
          <TopikChoice correct>Yes</TopikChoice>
          <TopikChoice>No</TopikChoice>
        </TopikQuestion>
      </TopikQuiz>,
    );

    expect(html).toContain('class="topik-quiz"');
    expect(html).toContain('class="topik-question"');
    expect(html).toContain('type="radio"');
  });

  it("handles single-choice quiz answers and explanations", () => {
    const dom = mount(
      <TopikQuestion type="single-choice">
        <TopikChoice correct>Correct answer</TopikChoice>
        <TopikChoice>Wrong answer</TopikChoice>
        <TopikExplanation>Because the first choice is correct.</TopikExplanation>
      </TopikQuestion>,
    );

    const inputs = dom.querySelectorAll<HTMLInputElement>("input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].type).toBe("radio");
    expect(dom.textContent).not.toContain("Because the first choice is correct.");

    act(() => inputs[1].click());

    expect(dom.querySelector(".topik-question")?.getAttribute("data-correct")).toBe("false");
    expect(dom.textContent).toContain("Try again");
    expect(dom.textContent).toContain("Because the first choice is correct.");

    act(() => inputs[0].click());

    expect(dom.querySelector(".topik-question")?.getAttribute("data-correct")).toBe("true");
    expect(dom.textContent).toContain("Correct");
  });

  it("handles multiple-choice quiz answers", () => {
    const dom = mount(
      <TopikQuestion type="multiple-choice">
        <TopikChoice correct>Alpha</TopikChoice>
        <TopikChoice correct>Beta</TopikChoice>
        <TopikChoice>Gamma</TopikChoice>
      </TopikQuestion>,
    );

    const inputs = dom.querySelectorAll<HTMLInputElement>("input");
    expect(inputs[0].type).toBe("checkbox");

    act(() => inputs[0].click());
    expect(dom.querySelector(".topik-question")?.getAttribute("data-correct")).toBe("false");

    act(() => inputs[1].click());
    expect(dom.querySelector(".topik-question")?.getAttribute("data-correct")).toBe("true");

    act(() => inputs[2].click());
    expect(dom.querySelector(".topik-question")?.getAttribute("data-correct")).toBe("false");
  });
});
