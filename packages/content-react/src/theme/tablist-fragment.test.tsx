// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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

const content = [
  "{% tabs %}",
  '{% tab title="macOS" %}',
  "## macOS setup",
  "{% /tab %}",
  '{% tab title="Windows" %}',
  "## Windows setup",
  "{% /tab %}",
  "{% /tabs %}",
].join("\n");

function selectedTab(dom: HTMLElement): string | null | undefined {
  return dom.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
}

describe("tab panels and fragment links", () => {
  it("selects the tab whose panel holds the target when the page loads", () => {
    window.history.replaceState(null, "", "/#windows-setup");
    const dom = mount(<TopikContent content={content} />);
    expect(selectedTab(dom)).toBe("Windows");
    expect(document.getElementById("windows-setup")?.closest("[hidden]")).toBeNull();
  });

  it("selects the tab when the fragment changes to an element inside it", () => {
    const dom = mount(<TopikContent content={content} />);
    expect(selectedTab(dom)).toBe("macOS");
    act(() => {
      window.history.replaceState(null, "", "/#windows-setup");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(selectedTab(dom)).toBe("Windows");
    act(() => {
      window.history.replaceState(null, "", "/#elsewhere");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(selectedTab(dom)).toBe("Windows");
  });
});
