// @vitest-environment jsdom

import { act, Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as content from "@topik/content";
import { InvalidTopikContentError, type TopikAssetResolutionDiagnostic } from "../core/render";
import type { TopikComponentProps } from "../core/components";
import { TopikContentProvider } from "../core/context";
import { getRichTopikComponents } from "../rich";
import { TopikContent } from "./TopikContent";
import { TopikCallout } from "./components";

vi.mock("@topik/content", { spy: true });

const missingAsset = `![Hero](asset:auto-v1-${"a".repeat(52)})`;
const quiz = [
  "{% quiz %}",
  "{% question %}",
  "{% choice correct=true %}",
  "Yes",
  "{% /choice %}",
  "{% choice %}",
  "No",
  "{% /choice %}",
  "{% /question %}",
  "{% /quiz %}",
].join("\n");
const document = [
  "[Link](/link)",
  '{% card title="Card" href="/card" %}\nBody\n{% /card %}',
  '{% figure src="https://example.com/light.png" darkSrc="https://example.com/dark.png" alt="Theme" /%}',
  '{% tabs %}\n{% tab title="One" %}\nFirst\n{% /tab %}\n{% tab title="Two" %}\nSecond\n{% /tab %}\n{% /tabs %}',
  quiz,
].join("\n\n");

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

function mount(element: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function render(element: ReactNode) {
  act(() => root?.render(element));
}

describe("TopikContent diagnostics", () => {
  it("reports asset diagnostics once after commit when the parent stores them in state", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: TopikAssetResolutionDiagnostic[][] = [];
    function Parent() {
      const [diagnostics, setDiagnostics] = useState<TopikAssetResolutionDiagnostic[]>([]);
      seen.push(diagnostics);
      return (
        <TopikContent
          content={missingAsset}
          onAssetDiagnostic={(diagnostic) => setDiagnostics((current) => [...current, diagnostic])}
        />
      );
    }
    mount(<Parent />);
    expect(seen.at(-1)).toEqual([
      {
        id: "TOPIK_ASSET_REFERENCE_MISSING",
        message: "Asset name could not be resolved",
        name: `auto-v1-${"a".repeat(52)}`,
        slot: "image.src",
      },
    ]);
    expect(seen.length).toBeLessThanOrEqual(3);
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not double-report diagnostics under StrictMode", () => {
    const onAssetDiagnostic = vi.fn();
    const onDiagnostic = vi.fn();
    mount(
      <StrictMode>
        <TopikContent content={missingAsset} onAssetDiagnostic={onAssetDiagnostic} />
        <TopikContent
          content='{% mystery private="opaque" /%}'
          invalidContent="placeholder"
          onDiagnostic={onDiagnostic}
        />
      </StrictMode>,
    );
    expect(onAssetDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "reports thrown content once, after commit and before the error (StrictMode %s)",
    (strict) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const source = '{% mystery private="opaque" /%}';
      const expected = content.compileTopikContent(source);
      if (expected.ok) throw new Error("Expected invalid content");
      const events: string[] = [];
      class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        componentDidCatch(error: unknown) {
          events.push(error instanceof InvalidTopikContentError ? "error" : "unexpected");
        }
        render() {
          return this.state.failed ? "Failed" : this.props.children;
        }
      }
      function Parent() {
        const [count, setCount] = useState(0);
        return (
          <Boundary>
            <span>{count}</span>
            <TopikContent
              content={source}
              onDiagnostic={(diagnostic) => {
                events.push(diagnostic.id);
                // Updating another component is only allowed outside render.
                setCount((current) => current + 1);
              }}
            />
          </Boundary>
        );
      }
      const dom = mount(
        strict ? (
          <StrictMode>
            <Parent />
          </StrictMode>
        ) : (
          <Parent />
        ),
      );
      expect(dom.textContent).toBe("Failed");
      expect(events).toEqual([...expected.diagnostics.map((diagnostic) => diagnostic.id), "error"]);
      expect(
        errors.mock.calls.some((call) => String(call[0]).includes("while rendering a different")),
      ).toBe(false);
    },
  );

  it("reports again only when the content changes", () => {
    const onAssetDiagnostic = vi.fn();
    mount(<TopikContent content={missingAsset} onAssetDiagnostic={onAssetDiagnostic} />);
    render(<TopikContent content={missingAsset} onAssetDiagnostic={(d) => onAssetDiagnostic(d)} />);
    expect(onAssetDiagnostic).toHaveBeenCalledTimes(1);
    render(
      <TopikContent content={`Changed\n\n${missingAsset}`} onAssetDiagnostic={onAssetDiagnostic} />,
    );
    expect(onAssetDiagnostic).toHaveBeenCalledTimes(2);
  });

  it("uses the latest callback without recomputing", () => {
    const first = vi.fn();
    const second = vi.fn();
    mount(<TopikContent content="Hello" onAssetDiagnostic={first} />);
    render(<TopikContent content={missingAsset} onAssetDiagnostic={second} />);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("deduplicates resolution diagnostics from inline resolvers", () => {
    const onLinkDiagnostic = vi.fn();
    function Parent() {
      const [count, setCount] = useState(0);
      return (
        <TopikContent
          content="[Wiki](ref://wiki-page/missing)"
          resolveLink={() => undefined}
          onLinkDiagnostic={(diagnostic) => {
            onLinkDiagnostic(diagnostic);
            setCount(count + 1);
          }}
        />
      );
    }
    mount(<Parent />);
    expect(onLinkDiagnostic).toHaveBeenCalledTimes(1);
  });
});

describe("TopikContent render stability", () => {
  it("does not recompile or remount when the parent passes new inline options", () => {
    const compile = vi.mocked(content.compileTopikContent);
    compile.mockClear();
    let calloutMounts = 0;
    function CountingCallout(props: TopikComponentProps) {
      useEffect(() => {
        calloutMounts++;
      }, []);
      return <TopikCallout {...props} />;
    }
    const page = (label: string) => (
      <TopikContentProvider components={{ TopikCallout: CountingCallout }}>
        <span>{label}</span>
        <TopikContent
          content={`{% callout title="Note" %}\nBody\n{% /callout %}\n\n${document}`}
          config={{ variables: { student: { name: "Ada" } } }}
          components={{ TopikCallout: CountingCallout }}
          onNavigateLink={() => true}
          renderLink={(props) => <a {...props} data-label={label} />}
          resolveAsset={(name) => `/assets/${name}`}
          resolveLink={(href) => href}
          onAssetDiagnostic={() => {}}
          onDiagnostic={() => {}}
        />
      </TopikContentProvider>
    );
    const dom = mount(page("first"));
    expect(compile).toHaveBeenCalledTimes(1);

    const radios = dom.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    act(() => radios[0].click());
    const secondTab = [...dom.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1];
    act(() => secondTab.click());
    const link = dom.querySelector("a");
    const image = dom.querySelector("img");

    render(page("second"));
    render(page("third"));

    expect(compile).toHaveBeenCalledTimes(1);
    expect(calloutMounts).toBe(1);
    expect(dom.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect(dom.querySelector('[role="status"]')?.textContent).toBe("Correct");
    expect(
      [...dom.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("aria-selected")),
    ).toEqual(["false", "true"]);
    // Same DOM nodes: links, cards and figures were updated rather than remounted.
    expect(dom.querySelector("a")).toBe(link);
    expect(dom.querySelector("img")).toBe(image);
    // The latest renderLink still applies.
    expect(dom.querySelector("a")?.dataset.label).toBe("third");
  });

  it("keeps slot identities stable for repeated full component maps", () => {
    const first = getRichTopikComponents();
    const second = getRichTopikComponents();
    expect(second.TopikLink).toBe(first.TopikLink);
    expect(second.TopikCard).toBe(first.TopikCard);
    expect(second.TopikFigure).toBe(first.TopikFigure);
    expect(second.TopikChoice).toBe(first.TopikChoice);
    expect(second.TopikExplanation).toBe(first.TopikExplanation);
  });

  it("recompiles when compilation inputs change", () => {
    const compile = vi.mocked(content.compileTopikContent);
    compile.mockClear();
    const dom = mount(
      <TopikContent
        content="Hello {% $student.name %}"
        config={{ variables: { student: { name: "Ada" } } }}
      />,
    );
    render(
      <TopikContent
        content="Hello {% $student.name %}"
        config={{ variables: { student: { name: "Grace" } } }}
      />,
    );
    expect(compile).toHaveBeenCalledTimes(2);
    expect(dom.textContent).toContain("Hello Grace");
  });
});
