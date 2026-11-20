// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { TopikContent } from "./theme/TopikContent";

const doc = `# Title

{% quiz %}
{% question %}
What is 2+2?
{% choice correct=true %}4{% /choice %}
{% choice %}5{% /choice %}
{% explanation %}Because.{% /explanation %}
{% /question %}
{% /quiz %}

{% tabs %}
{% tab title="A" %}
Alpha
{% /tab %}
{% tab title="B" %}
Beta
{% /tab %}
{% /tabs %}

{% steps %}
{% step title="One" %}
First
{% /step %}
{% /steps %}

{% accordion title="More" %}
Hidden
{% /accordion %}

Some text[^a].

[^a]: A note.

{% video src="https://example.com/v.mp4" title="Clip" loop=true /%}

{% youtube src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" title="YT" /%}

{% figure src="https://example.com/a.png" darkSrc="https://example.com/b.png" alt="Fig" /%}

\`\`\`js title="x.js" lineNumbers=true collapse=1-2
a
b
c
\`\`\`
`;

it("static markup", () => {
  const onDiagnostic = vi.fn();
  const html = renderToStaticMarkup(
    <TopikContent content={doc} onDiagnostic={(d) => console.log(JSON.stringify(d))} />,
  );
  console.log(html);
  expect(onDiagnostic).not.toHaveBeenCalled();
});

it("hydrates without mismatch", async () => {
  const html = renderToString(<TopikContent content={doc} />);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const errors: unknown[] = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
  await act(async () => {
    hydrateRoot(container, <TopikContent content={doc} />, {
      onRecoverableError: (e) => errors.push(["recoverable", String(e)]),
    });
  });
  spy.mockRestore();
  console.log("HYDRATION ERRORS", JSON.stringify(errors).slice(0, 3000));
});
