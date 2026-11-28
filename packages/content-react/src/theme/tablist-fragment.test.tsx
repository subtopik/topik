// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TopikContent } from "./TopikContent";
import { TopikTablist, type TopikTablistItem } from "./tablist";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
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

function renderTablist(items: TopikTablistItem[]) {
  return (
    <TopikTablist
      className="topik-tabs"
      items={items}
      label="Platforms"
      listClassName="topik-tabs__list"
      panelClassName="topik-tabs__panel"
      panelId="panel"
      tabClassName="topik-tabs__tab"
      tabId="tab"
    />
  );
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

  it("attaches hashchange when mounted empty and selects a tab once items populate", () => {
    const dom = mount(renderTablist([]));
    expect(selectedTab(dom)).toBeUndefined();

    act(() => {
      root?.render(
        renderTablist([
          { label: "macOS", panel: <h2 id="macos-setup">macOS setup</h2> },
          { label: "Windows", panel: <h2 id="windows-setup">Windows setup</h2> },
        ]),
      );
    });
    expect(selectedTab(dom)).toBe("macOS");

    act(() => {
      window.history.replaceState(null, "", "/#windows-setup");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(selectedTab(dom)).toBe("Windows");
    expect(document.getElementById("windows-setup")?.closest("[hidden]")).toBeNull();
  });

  it("cancels a pending animation frame on unmount and before rescheduling", () => {
    let nextId = 10;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => ++nextId);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    window.history.replaceState(null, "", "/#windows-setup");
    mount(<TopikContent content={content} />);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    const firstId = nextId;

    act(() => {
      window.history.replaceState(null, "", "/#macos-setup");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(cancelFrame).toHaveBeenCalledWith(firstId);
    expect(requestFrame).toHaveBeenCalledTimes(2);
    const secondId = nextId;

    act(() => root?.unmount());
    root = undefined;
    expect(cancelFrame).toHaveBeenCalledWith(secondId);
  });
});
