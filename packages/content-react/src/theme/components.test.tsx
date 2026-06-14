// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  TopikAccordion,
  TopikBadge,
  TopikCallout,
  TopikCard,
  TopikCardGrid,
  TopikChoice,
  TopikExplanation,
  TopikFigure,
  TopikQuestion,
  TopikQuiz,
  TopikStep,
  TopikSteps,
  TopikTab,
  TopikTabs,
} from "./components";

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

    expect(titled).toContain('class="topik-callout"');
    expect(titled).toContain('data-variant="warning"');
    expect(titled).toContain("Heads up");
    expect(untitled).toContain('data-variant="note"');
    expect(untitled).not.toContain("topik-callout__title");
  });

  it("renders card grids and cards with link, icon, title, and body slots", () => {
    const linked = renderToStaticMarkup(
      <TopikCardGrid columns={2}>
        <TopikCard href="/start" icon="S" title="Start">
          Open the guide.
        </TopikCard>
      </TopikCardGrid>,
    );
    const plain = renderToStaticMarkup(<TopikCard title="Plain">No link.</TopikCard>);

    expect(linked).toContain("topik-card-grid");
    expect(linked).toContain("--topik-card-grid-columns:2");
    expect(linked).toContain('<a class="topik-card" href="/start">');
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

  it("renders badge variants and defaults", () => {
    const success = renderToStaticMarkup(<TopikBadge variant="success">Stable</TopikBadge>);
    const neutral = renderToStaticMarkup(<TopikBadge>Draft</TopikBadge>);

    expect(success).toContain('class="topik-badge"');
    expect(success).toContain('data-variant="success"');
    expect(neutral).toContain('data-variant="neutral"');
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
