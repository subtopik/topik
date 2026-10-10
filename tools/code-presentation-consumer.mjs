import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  CODE_PRESENTATION_LIMITS,
  FORMAT_VERSION,
  TOPIK_ASSET_REFERENCE_VERSION,
  TOPIK_CONTENT_SCHEMA_VERSION,
  compileTopikContent,
  effectiveCodePresentationOptions,
  extractTopikAssetOccurrences,
  formatTopikContent,
  isContentTag,
  parseDocument,
  sameDocumentMeaning,
  writeDocument,
} from "@topik/content";
import { renderTopikContent } from "@topik/content-react";
import { getRichTopikComponents } from "@topik/content-react/rich";
import { defaultTopikComponents } from "@topik/content-react/theme";
import { renderToStaticMarkup, renderToString } from "react-dom/server";

const fence = "`".repeat(3);
const presented = (payload, options = {}, language = "text", suffix = "") => {
  const attributes = Object.entries(options)
    .map(([key, value]) => {
      const name = key === "lineNumbers" ? "lines" : key;
      if (typeof value === "boolean") return value ? name : `${name}=false`;
      return `${name}=${typeof value === "string" ? JSON.stringify(value) : value}`;
    })
    .join(" ");
  return [`${fence}${language}${attributes ? ` ${attributes}` : ""}${suffix}`, payload, fence].join(
    "\n",
  );
};
const tags = (tree, name) => {
  const found = [];
  const visit = (node) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (isContentTag(node)) {
      if (node.name === name) found.push(node);
      node.children.forEach(visit);
    }
  };
  visit(tree);
  return found;
};

/** Run from a clean npm-installed cohort; no workspace modules may satisfy imports. */
export function verifyCodePresentationConsumer() {
  const topikBoundary = new URL("./node_modules/@topik/", import.meta.url).href;
  for (const name of [
    "@topik/content",
    "@topik/content-react",
    "@topik/content-react/rich",
    "@topik/content-react/theme",
  ])
    assert.ok(import.meta.resolve(name).startsWith(topikBoundary), `${name} escaped the consumer`);
  for (const name of ["shiki", "mermaid", "katex"])
    assert.throws(() => import.meta.resolve(name), { code: "ERR_MODULE_NOT_FOUND" });
  assert.equal(TOPIK_CONTENT_SCHEMA_VERSION, "0.2.2");
  assert.equal(FORMAT_VERSION, 1);
  assert.equal(TOPIK_ASSET_REFERENCE_VERSION, "topik-asset-reference-v1");
  assert.equal(CODE_PRESENTATION_LIMITS.rows, 20_000);
  assert.deepEqual(effectiveCodePresentationOptions({}), {
    lineNumbers: false,
    startLine: 1,
    wrap: false,
  });
  const compact = compileTopikContent(
    [`${fence}ts filename="client.ts" lines highlight="2"`, "one", "two", fence].join("\n"),
  );
  assert.equal(compact.ok, true, JSON.stringify(compact));
  assert.deepEqual(tags(compact.tree, "TopikCodeBlock")[0].attributes.presentation, {
    filename: "client.ts",
    lineNumbers: true,
    startLine: 1,
    highlight: [[2, 2]],
    wrap: false,
  });

  const payload = '+ source marker\t  \n<old&>  \nconst next = "ready";\n';
  const options = {
    filename: "client.ts",
    title: "Create <client&>",
    lineNumbers: true,
    startLine: 10,
    highlight: "4,1-2,2",
    focus: "3-4",
    collapse: "3-4",
    wrap: true,
    added: "1",
    removed: "2",
  };
  const source = presented(
    payload,
    options,
    "unavailable-topik-language",
    " legacy&#x26;amp;value",
  );
  const parsed = parseDocument(source);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  const node = parsed.document.children[0];
  assert.equal(node.type, "topikCodePresentation");
  assert.equal(node.children[0].value, payload);
  assert.equal(node.children[0].meta, undefined);
  assert.equal(node.opaqueMetaSuffix, " legacy&amp;value");
  assert.deepEqual(node.options.highlight, [
    [1, 2],
    [4, 4],
  ]);
  assert.deepEqual(node.options.collapse, [[3, 4]]);
  const snapshot = JSON.stringify(parsed.document);
  const written = writeDocument(parsed.document);
  const reopened = parseDocument(written);
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(sameDocumentMeaning(parsed.document, reopened.document), true);
  assert.ok(written.includes("legacy&#38;amp;value"));
  const formatted = formatTopikContent(source);
  assert.equal(formatted.ok, true, JSON.stringify(formatted));
  assert.equal(formatTopikContent(formatted.formatted).formatted, formatted.formatted);
  assert.equal(extractTopikAssetOccurrences(source).length, 0);

  const compiled = compileTopikContent(source);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  assert.equal(compiled.source, source);
  const attributes = tags(compiled.tree, "TopikCodeBlock")[0].attributes;
  assert.equal(attributes.payload, payload);
  assert.equal(attributes.content, payload + "\n");
  assert.deepEqual(attributes.presentation, node.options);
  assert.equal(JSON.stringify(parsed.document), snapshot);

  // SSR proves options and readable fallback survive without optional rich peers.
  for (const components of [defaultTopikComponents, getRichTopikComponents()]) {
    const html = renderToStaticMarkup(renderTopikContent(compiled, { components }));
    assert.equal((html.match(/class="topik-code-block__row"/g) ?? []).length, 4);
    assert.ok(!/\shidden(?:=|\s|>)/.test(html), "Unhydrated code must include every physical row");
    assert.ok(html.includes("Create &lt;client&amp;&gt;"));
    assert.ok(html.includes("client.ts"));
    assert.ok(html.includes("&lt;old&amp;&gt;  "));
    assert.ok(!html.includes("&amp;lt;"));
    assert.ok(html.includes('data-line="4"'), "Authored final blank row must remain visible");
    assert.ok(html.includes('data-wrap="true"'));
    assert.ok(html.includes('data-diff="added"'));
    assert.ok(html.includes('data-diff="removed"'));
    assert.ok(html.includes("Added line: "));
    assert.ok(html.includes("Removed line: "));
    assert.ok(html.includes('aria-expanded="true"'));
    assert.ok(html.includes("Wrap lines"));
    assert.ok(html.includes("Copy"));
    assert.ok(html.includes('class="topik-code-block__line-number">10</span>'));
    assert.ok(html.includes('class="topik-code-block__line-number">13</span>'));
  }

  for (const payload of ["", "one", "a\n\n", "\t  \nlast  "]) {
    const rowCount = payload.split("\n").length;
    const result = compileTopikContent(
      presented(payload, { lineNumbers: false, collapse: rowCount === 1 ? "1" : `1-${rowCount}` }),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const code = tags(result.tree, "TopikCodeBlock")[0].attributes;
    assert.equal(code.payload, payload);
    assert.equal(code.content, payload + "\n");
    assert.deepEqual(code.presentation, {
      lineNumbers: false,
      startLine: 1,
      collapse: [[1, rowCount]],
      wrap: false,
    });
    for (const components of [defaultTopikComponents, getRichTopikComponents()]) {
      const html = renderToStaticMarkup(renderTopikContent(result, { components }));
      assert.equal(
        (html.match(/class="topik-code-block__row"/g) ?? []).length,
        payload.split("\n").length,
      );
    }
  }

  const disjointSource = presented("one\ntwo\nthree\nfour\nfive\nsix", {
    startLine: 90,
    collapse: "5,2,4",
  });
  const disjointParsed = parseDocument(disjointSource);
  assert.equal(disjointParsed.ok, true, JSON.stringify(disjointParsed));
  assert.deepEqual(disjointParsed.document.children[0].options.collapse, [
    [2, 2],
    [4, 5],
  ]);
  const disjointWritten = writeDocument(disjointParsed.document);
  assert.ok(disjointWritten.includes('collapse="2,4-5"'));
  assert.equal(
    sameDocumentMeaning(disjointParsed.document, parseDocument(disjointWritten).document),
    true,
  );
  const disjoint = compileTopikContent(disjointWritten);
  assert.equal(disjoint.ok, true, JSON.stringify(disjoint));
  for (const components of [defaultTopikComponents, getRichTopikComponents()]) {
    const html = renderToStaticMarkup(renderTopikContent(disjoint, { components }));
    assert.equal((html.match(/class="topik-code-block__row"/g) ?? []).length, 6);
    assert.ok(!/\shidden(?:=|\s|>)/.test(html));
    const controls = [...html.matchAll(/<button\b[^>]*>/g)]
      .map(([button]) => button)
      .filter((button) => button.includes("topik-code-block__fold-toggle"));
    assert.equal(controls.length, 2);
    for (const [index, [start, end]] of [
      [2, 2],
      [4, 5],
    ].entries()) {
      assert.ok(controls[index].includes(`data-collapse-start="${start}"`));
      assert.ok(controls[index].includes(`data-collapse-end="${end}"`));
      assert.ok(controls[index].includes('aria-expanded="true"'));
      assert.ok(/\sdisabled(?:=|\s|>)/.test(controls[index]));
    }
    assert.ok(html.includes("Hide line 2"));
    assert.ok(html.includes("Hide lines 4–5"));
  }

  const grouped = [
    "{% codeGroup %}",
    '{% codeTab title="Both" %}',
    presented("first", { title: "First", startLine: 40 }),
    "",
    presented("second\nthird", { title: "Second", highlight: "2" }),
    "{% /codeTab %}",
    "{% /codeGroup %}",
  ].join("\n");
  const group = compileTopikContent(grouped);
  assert.equal(group.ok, true, JSON.stringify(group));
  assert.deepEqual(
    tags(group.tree, "TopikCodeBlock").map((code) => code.attributes.content),
    ["first\n", "second\nthird\n"],
  );
  assert.deepEqual(
    tags(group.tree, "TopikCodeBlock").map((code) => code.attributes.presentation.title),
    ["First", "Second"],
  );

  const templateSource = [
    "{% template code %}",
    `${fence}sh highlight="1" filename="{% $literal %}" title="legacy&#x26;amp;value"`,
    "echo {% $name %}",
    "echo {%% $literal %}",
    fence,
    "{% /template code %}",
  ].join("\n");
  const template = compileTopikContent(templateSource, {
    config: { variables: { name: "<Ada&>" } },
  });
  assert.equal(template.ok, true, JSON.stringify(template));
  assert.equal(template.source, templateSource);
  assert.equal(
    tags(template.tree, "TopikCodeBlock")[0].attributes.content,
    "echo <Ada&>\necho {% $literal %}\n",
  );
  assert.equal(
    tags(template.tree, "TopikCodeBlock")[0].attributes.presentation.filename,
    "{% $literal %}",
  );
  assert.equal(
    tags(template.tree, "TopikCodeBlock")[0].attributes.presentation.title,
    "legacy&amp;value",
  );
  assert.equal(extractTopikAssetOccurrences(templateSource).length, 0);
  for (const components of [defaultTopikComponents, getRichTopikComponents()])
    assert.ok(
      renderToStaticMarkup(renderTopikContent(template, { components })).includes(
        "echo &lt;Ada&amp;&gt;",
      ),
    );

  for (const invalid of [
    `${fence}ts filename="unterminated\none\n${fence}`,
    `${fence}ts lines lines=false\none\n${fence}`,
    `${fence}ts wrap=maybe\none\n${fence}`,
    `${fence}ts title="&#10;"\none\n${fence}`,
    presented("one", { highlight: "2" }),
    presented("one", { collapse: "2" }),
    presented("one\ntwo", { collapse: "1-" }),
    presented("one\ntwo", { added: "1", removed: "1" }),
    presented("graph LR; A-->B", { lineNumbers: true }, "mermaid"),
  ]) {
    const refused = compileTopikContent(invalid);
    assert.equal(refused.ok, false);
    assert.equal(refused.source, invalid);
    assert.ok(refused.diagnostics.length > 0);
    assert.equal(Object.hasOwn(refused, "tree"), false);
  }
  const ordinarySource = `${fence}ts unknown=value\none\n${fence}`;
  const ordinary = parseDocument(ordinarySource);
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary));
  assert.equal(ordinary.document.children[0].type, "code");
  assert.equal(ordinary.document.children[0].meta, "unknown=value");
  for (const [rawMeta, opaqueMeta] of [
    ["lines:note", "lines:note"],
    ["wrap:note", "wrap:note"],
    ["filename:note", "filename:note"],
    [String.raw`lines\=false`, "lines=false"],
  ]) {
    for (const templated of [false, true]) {
      const payload = "echo {% $name %}\t  \nlast  ";
      const codeSource = [`${fence}sh ${rawMeta}`, payload, fence].join("\n");
      const source = templated
        ? `{% template code %}\n${codeSource}\n{% /template code %}`
        : codeSource;
      const parsed = parseDocument(source);
      assert.equal(parsed.ok, true, JSON.stringify(parsed));
      assert.equal(parsed.document.children[0].type, templated ? "topikCodeTemplate" : "code");
      assert.equal(parsed.document.children[0].meta, opaqueMeta);
      const snapshot = JSON.stringify(parsed.document);
      const serialized = writeDocument(parsed.document);
      const reopened = parseDocument(serialized);
      assert.equal(reopened.ok, true, JSON.stringify(reopened));
      assert.equal(sameDocumentMeaning(parsed.document, reopened.document), true);
      assert.equal(reopened.document.children[0].meta, opaqueMeta);
      const formatted = formatTopikContent(source);
      assert.equal(formatted.ok, true, JSON.stringify(formatted));
      assert.equal(formatTopikContent(formatted.formatted).formatted, formatted.formatted);
      const compiled = compileTopikContent(serialized, {
        config: { variables: { name: "<Ada&>" } },
      });
      assert.equal(compiled.ok, true, JSON.stringify(compiled));
      assert.equal(compiled.source, serialized);
      const attributes = tags(compiled.tree, "TopikCodeBlock")[0].attributes;
      assert.equal(Object.hasOwn(attributes, "presentation"), false);
      assert.equal(
        attributes.payload,
        templated ? payload.replace("{% $name %}", "<Ada&>") : payload,
      );
      assert.equal(attributes.content, attributes.payload + "\n");
      assert.equal(JSON.stringify(parsed.document), snapshot);
    }
  }
}

/** JSDOM is test tooling only; the reader and its React runtime stay npm-installed. */
export async function verifyHydratedCodePresentationConsumer(domModulePath) {
  const { JSDOM } = await import(pathToFileURL(domModulePath).href);
  const dom = new JSDOM("<!doctype html><div id=reader></div>", { pretendToBeVisual: true });
  const saved = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value) => copied.push(value) },
  });
  const { act } = await import("react");
  const { hydrateRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("reader");
  let root;
  try {
    const payload = "+ source marker\t  \n<old&>  \nthird\nfourth  \nfifth\n";
    const source = presented(
      payload,
      {
        title: "Packed fallback",
        lineNumbers: true,
        startLine: 10,
        focus: "1",
        collapse: "5,2,4",
        wrap: true,
        added: "1",
        removed: "2",
      },
      "unavailable-topik-language",
    );
    const compiled = compileTopikContent(source);
    assert.equal(compiled.ok, true, JSON.stringify(compiled));
    const reader = renderTopikContent(compiled, { components: getRichTopikComponents() });
    container.innerHTML = renderToString(reader);
    assert.equal(container.querySelectorAll(".topik-code-block__region[hidden]").length, 0);
    const serverControls = [...container.querySelectorAll(".topik-code-block__fold-toggle")];
    assert.equal(serverControls.length, 2);
    for (const control of serverControls) {
      assert.equal(control.disabled, true);
      assert.equal(control.getAttribute("aria-expanded"), "true");
    }
    const hydrationErrors = [];
    await act(async () => {
      root = hydrateRoot(container, reader, {
        onRecoverableError: (error) => hydrationErrors.push(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(hydrationErrors, []);
    assert.equal(container.querySelectorAll(".topik-code-block__row").length, 6);
    const hiddenLines = () =>
      [...container.querySelectorAll(".topik-code-block__region[hidden] [data-line]")].map((row) =>
        Number(row.getAttribute("data-line")),
      );
    assert.deepEqual(hiddenLines(), [2, 4, 5]);
    assert.equal(
      container.querySelector(".shiki"),
      null,
      "Unavailable Shiki must fall back to readable rows",
    );
    assert.equal(
      container.querySelector('[data-line="2"] .topik-code-block__text').textContent,
      "<old&>  \n",
    );
    assert.equal(
      container.querySelector('[data-line="2"] .topik-code-block__sr-only').textContent,
      "Removed line: ",
    );
    const buttons = [...container.querySelectorAll("button")];
    const copy = buttons.find((button) => button.textContent === "Copy");
    const wrap = buttons.find((button) => button.textContent === "Wrap lines");
    const firstFold = container.querySelector(
      '.topik-code-block__fold-toggle[data-collapse-start="2"]',
    );
    const secondFold = container.querySelector(
      '.topik-code-block__fold-toggle[data-collapse-start="4"]',
    );
    assert.equal(copy.disabled, false);
    assert.equal(firstFold.getAttribute("aria-expanded"), "false");
    assert.equal(secondFold.getAttribute("aria-expanded"), "false");
    assert.equal(firstFold.textContent, "Show line 11");
    assert.equal(secondFold.textContent, "Show lines 13–14");
    await act(async () => copy.click());
    assert.deepEqual(copied, [payload + "\n"]);
    firstFold.focus();
    await act(async () => firstFold.click());
    assert.equal(firstFold.getAttribute("aria-expanded"), "true");
    assert.equal(firstFold.textContent, "Hide line 11");
    assert.equal(secondFold.getAttribute("aria-expanded"), "false");
    assert.deepEqual(hiddenLines(), [4, 5]);
    assert.equal(dom.window.document.activeElement, firstFold);
    secondFold.focus();
    await act(async () => secondFold.click());
    assert.equal(secondFold.getAttribute("aria-expanded"), "true");
    assert.deepEqual(hiddenLines(), []);
    assert.equal(
      [...container.querySelectorAll(".topik-code-block__text")]
        .map((node) => node.textContent)
        .join(""),
      payload + "\n",
    );
    assert.equal(dom.window.document.activeElement, secondFold);
    await act(async () => firstFold.click());
    assert.equal(firstFold.getAttribute("aria-expanded"), "false");
    assert.equal(secondFold.getAttribute("aria-expanded"), "true");
    assert.deepEqual(hiddenLines(), [2]);
    wrap.focus();
    await act(async () => wrap.click());
    assert.equal(wrap.getAttribute("aria-pressed"), "false");
    assert.equal(dom.window.document.activeElement, wrap);
    await act(async () => copy.click());
    assert.deepEqual(copied, [payload + "\n", payload + "\n"]);
    assert.equal(compiled.source, source);
    assert.equal(tags(compiled.tree, "TopikCodeBlock")[0].attributes.content, payload + "\n");
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyCodePresentationConsumer();
  if (process.argv[2]) {
    await verifyHydratedCodePresentationConsumer(process.argv[2]);
    console.log(
      "Verified installed hydrated rich code, missing-Shiki fallback and exact clipboard payload",
    );
  }
  console.log(
    "Verified installed code-presentation options, payload, plain/rich SSR and absent optional peers",
  );
}
