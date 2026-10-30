import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Exercise the packed rich renderer with real optional peers and native MathML.
const { build, preview } = await import(pathToFileURL(process.argv[2]).href);
const playwrightModule = await import(pathToFileURL(process.argv[3]).href);
const { chromium } = playwrightModule.default ?? playwrightModule;
const root = import.meta.dirname;
const html = join(root, "diagram-math.html");
const app = join(root, "diagram-math-app.js");
const output = join(root, "diagram-math-dist");
const source = String.raw`flowchart LR
  accTitle: Formula graph
  accDescr: A fraction and a sum lead to the energy equation.
  A["Before $$\frac{x_1^2}{\sqrt{y}}$$ after"] -->|"$$\sum_{i=1}^{n} i$$"| B["$$E=mc^2$$"]`;
const ordinary = "flowchart LR\n A[Plain] --> B[Diagram]";
await writeFile(
  html,
  '<div id="root"></div><script type="module" src="/diagram-math-app.js"></script>',
);
await writeFile(
  app,
  `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { RichTopikThemeProvider, RichTopikMermaid } from "@topik/content-react/rich";
import "@topik/content-react/rich/styles.css";
const root = createRoot(document.getElementById("root"));
window.show = (content, theme = "light", together = false) => {
  const diagram = (value, key) => createElement(RichTopikThemeProvider, { theme: value, key },
    createElement(RichTopikMermaid, { content }));
  root.render(together ? [diagram("light", 0), diagram("dark", 1)] : diagram(theme, 0));
};
window.dispose = () => root.unmount();
window.show(${JSON.stringify(ordinary)});
`,
);
let host;
let browser;
let page;
const errors = [];
const messages = [];
try {
  // Production bundling handles the installed packages' CommonJS dependencies
  // and preserves their lazy peer imports as separate browser chunks.
  await build({
    root,
    configFile: false,
    logLevel: "error",
    build: {
      outDir: output,
      emptyOutDir: true,
      manifest: true,
      rollupOptions: { input: html },
    },
  });
  const manifest = JSON.parse(await readFile(join(output, ".vite/manifest.json"), "utf8"));
  const katexChunks = Object.entries(manifest)
    .filter(([id, chunk]) => chunk.isDynamicEntry && /katex/i.test(id))
    .map(([, chunk]) => chunk.file);
  assert.ok(katexChunks.length > 0, "the browser build must retain a separate lazy KaTeX chunk");
  const requestsKaTeX = (url) =>
    katexChunks.some((file) => new URL(url).pathname.endsWith(`/${file}`));
  host = await preview({
    root,
    configFile: false,
    logLevel: "error",
    build: { outDir: output },
    preview: { host: "127.0.0.1", port: 0 },
  });
  const origin = `http://127.0.0.1:${host.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) messages.push(message.text());
  });
  await page.goto(`${origin}/diagram-math.html`);
  await page.locator(".topik-rich-mermaid svg").waitFor();
  assert.equal(requests.some(requestsKaTeX), false, "plain diagrams must not load KaTeX");

  await page.evaluate((content) => window.show(content), source);
  await page.waitForFunction(() => document.querySelectorAll("foreignObject math").length === 3);
  assert.ok(requests.some(requestsKaTeX));
  assert.equal(await page.locator("pre.topik-mermaid, .katex, .katex-html").count(), 0);
  assert.equal(await page.getByLabel("Formula graph", { exact: true }).count(), 1);
  const geometry = await page.locator("foreignObject").evaluateAll((boxes) =>
    boxes.map((box) => {
      const rect = box.getBoundingClientRect();
      const math = box.querySelector("math").getBoundingClientRect();
      return {
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        math: { x: math.x, y: math.y, width: math.width, height: math.height },
      };
    }),
  );
  for (const { box, math } of geometry) {
    assert.ok(math.width > 0 && math.height > 0);
    assert.ok(Math.abs(math.width - box.width) < 2, "measured math width must match its SVG box");
    assert.ok(
      Math.abs(math.height - box.height) < 2,
      "measured math height must match its SVG box",
    );
    assert.ok(Math.abs(math.x - box.x) < 2 && Math.abs(math.y - box.y) < 2);
  }
  await page.evaluate(() => {
    window.previousSvg = document.querySelector("svg");
  });
  const lightColor = await page
    .locator("math")
    .first()
    .evaluate((math) => getComputedStyle(math).color);
  await page.evaluate((content) => window.show(content, "dark"), source);
  await page.locator('.topik-rich-mermaid[data-theme="dark"]').waitFor();
  assert.equal(
    await page.evaluate(() => window.previousSvg === document.querySelector("svg")),
    true,
  );
  const darkColor = await page
    .locator("math")
    .first()
    .evaluate((math) => getComputedStyle(math).color);
  assert.notEqual(lightColor, darkColor);

  await page.evaluate((content) => window.show(content, "light", true), source);
  await page.waitForFunction(() => document.querySelectorAll("foreignObject math").length === 6);
  const ids = await page.locator(".topik-rich-mermaid svg").evaluateAll((svgs) =>
    svgs.map((svg) => {
      const title = svg.getAttribute("aria-labelledby");
      const desc = svg.getAttribute("aria-describedby");
      return {
        title,
        desc,
        titleText: document.getElementById(title)?.textContent,
        descText: document.getElementById(desc)?.textContent,
      };
    }),
  );
  assert.equal(new Set(ids.map(({ title }) => title)).size, 2);
  assert.equal(new Set(ids.map(({ desc }) => desc)).size, 2);
  for (const { titleText, descText } of ids) {
    assert.equal(titleText, "Formula graph");
    assert.equal(descText, "A fraction and a sum lead to the energy equation.");
  }
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const hostile = String.raw`flowchart LR
  A["$$\href{https://untrusted.example/link}{x}$$"] --> B["$$\includegraphics{https://untrusted.example/image}$$"]
  B --> C["$$\unknowncommand{x}$$"]
  click A "https://untrusted.example/click"`;
  await page.evaluate((content) => window.show(content), hostile);
  await page.waitForFunction(
    () =>
      document.querySelectorAll("svg").length === 1 &&
      document.querySelector("svg")?.textContent.includes("unknowncommand"),
  );
  assert.equal(
    await page.locator("svg a, svg image, svg img, svg script, svg [href], svg [src]").count(),
    0,
  );
  assert.equal(requests.some((url) => url.includes("untrusted.example")), false);
  assert.equal(await page.locator("pre.topik-mermaid").count(), 0);
  assert.equal(await page.locator('.topik-rich-mermaid[aria-hidden="true"]').count(), 0);
  await page.evaluate(() => window.dispose());
  assert.deepEqual(errors, []);
  console.log(
    "Verified packed diagram MathML, measurement, lazy peers, themes, accessibility and safe formula fallbacks",
  );
} catch (error) {
  console.error("Diagram math browser diagnostics", {
    errors,
    messages,
    body: await page?.locator("body").innerHTML().catch(() => "Page unavailable"),
  });
  throw error;
} finally {
  await browser?.close();
  if (host) {
    await new Promise((resolve, reject) => {
      host.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await rm(html, { force: true });
  await rm(app, { force: true });
  await rm(output, { recursive: true, force: true });
}
