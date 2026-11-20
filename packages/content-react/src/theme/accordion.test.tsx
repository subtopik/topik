// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TopikAccordion } from "./components";
import { TopikContent } from "./TopikContent";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  window.history.replaceState(null, "", "/");
});

function mount(element: ReactNode): HTMLElement {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function details(id: string): HTMLDetailsElement {
  return document.getElementById(id) as HTMLDetailsElement;
}

describe("TopikAccordion deep links", () => {
  it("renders its ID on the disclosure", () => {
    const html = renderToStaticMarkup(
      <TopikAccordion id="grading" title="Grading">
        Body
      </TopikAccordion>,
    );
    expect(html).toContain('<details class="topik-accordion" id="grading">');
  });

  it("opens when the page loads with a link to it", () => {
    window.history.replaceState(null, "", "/#grading");
    mount(
      <TopikAccordion id="grading" title="Grading">
        Body
      </TopikAccordion>,
    );
    expect(details("grading").open).toBe(true);
  });

  it("opens when the fragment changes to it or to an element inside it", () => {
    mount(
      <>
        <TopikAccordion id="grading" title="Grading">
          Body
        </TopikAccordion>
        <TopikAccordion id="faq" title="FAQ">
          <h3 id="retakes">Retakes</h3>
        </TopikAccordion>
      </>,
    );
    expect(details("grading").open).toBe(false);
    act(() => {
      window.history.replaceState(null, "", "/#retakes");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(details("faq").open).toBe(true);
    expect(details("grading").open).toBe(false);
  });

  it("decodes the fragment like fragment navigation does", () => {
    window.history.replaceState(null, "", "/#%C3%BCber-uns");
    mount(
      <TopikAccordion id="über-uns" title="Über uns">
        Body
      </TopikAccordion>,
    );
    expect(details("über-uns").open).toBe(true);
  });

  it("follows a changed authored open state", () => {
    const render = (open: boolean) => (
      <TopikAccordion id="grading" open={open} title="Grading">
        Body
      </TopikAccordion>
    );
    mount(render(false));
    act(() => root?.render(render(true)));
    expect(details("grading").open).toBe(true);
  });

  it("receives generated and explicit IDs from content", () => {
    const content = [
      "## FAQ",
      "",
      '{% accordion title="FAQ" %}',
      "Generated.",
      "{% /accordion %}",
      "",
      '{% accordion title="Grading" id="grading" %}',
      "Explicit.",
      "{% /accordion %}",
    ].join("\n");
    const html = renderToStaticMarkup(<TopikContent content={content} />);
    expect(html).toContain('id="faq"');
    expect(html).toContain('<details class="topik-accordion" id="faq-1">');
    expect(html).toContain('<details class="topik-accordion" id="grading">');
  });
});
