import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Bundle the packed rich renderer with Shiki installed and check what an app emits and loads:
// only the two themes in use, every language on demand, and WebAssembly only on the default path.
const { build, preview } = await import(pathToFileURL(process.argv[2]).href);
const playwrightModule = await import(pathToFileURL(process.argv[3]).href);
const { chromium } = playwrightModule.default ?? playwrightModule;
const root = import.meta.dirname;
const html = join(root, "code-highlight.html");
const app = join(root, "code-highlight-app.js");
const output = join(root, "code-highlight-dist");
// A strict host policy: scripts from the page origin only, without 'wasm-unsafe-eval'.
const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
await writeFile(
  html,
  '<div id="root"></div><script type="module" src="/code-highlight-app.js"></script>',
);
await writeFile(
  app,
  `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { RichTopikContentProvider } from "@topik/content-react/rich";
import { TopikContent } from "@topik/content-react/theme";
const engine = new URLSearchParams(location.search).get("engine") ?? undefined;
const content = "\`\`\`ts\\nconst answer: number = 42;\\n\`\`\`\\n\\n\`\`\`python\\nprint('hi')\\n\`\`\`";
createRoot(document.getElementById("root")).render(
  createElement(RichTopikContentProvider, { codeHighlightEngine: engine, theme: "dark" },
    createElement(TopikContent, { content })),
);
`,
);
let host;
let browser;
const failures = [];
try {
  let chunks;
  await build({
    root,
    configFile: false,
    logLevel: "error",
    build: { outDir: output, emptyOutDir: true, rollupOptions: { input: html } },
    plugins: [
      {
        name: "topik-highlight-graph",
        generateBundle(_, bundle) {
          chunks = Object.values(bundle).filter((file) => file.type === "chunk");
        },
      },
    ],
  });
  const containing = (pattern) =>
    chunks.filter((chunk) => chunk.moduleIds.some((id) => pattern.test(id)));
  const themes = containing(/[\\/]@shikijs[\\/]themes[\\/]/u);
  const themeNames = themes
    .flatMap((chunk) => chunk.moduleIds)
    .map((id) => /[\\/]@shikijs[\\/]themes[\\/]dist[\\/]([^\\/]+)\.mjs$/u.exec(id)?.[1])
    .filter(Boolean)
    .toSorted();
  assert.deepEqual(
    themeNames,
    ["github-dark", "github-light"],
    "only the themes in use are emitted",
  );
  const languages = containing(/[\\/]@shikijs[\\/]langs[\\/]/u);
  assert.ok(languages.length > 200, "every bundled language remains available on demand");
  const wasm = containing(
    /[\\/]engine-oniguruma[\\/]dist[\\/]wasm-inlined|[\\/]shiki[\\/]dist[\\/]wasm\.mjs$/u,
  );
  assert.equal(wasm.length, 1, "one lazy WebAssembly chunk");
  const [wasmChunk] = wasm;
  assert.equal(
    chunks.some((chunk) => chunk.imports.includes(wasmChunk.fileName)),
    false,
    "WebAssembly is never imported statically",
  );
  assert.ok(wasmChunk.isDynamicEntry, "WebAssembly loads only through its lazy import");
  host = await preview({
    root,
    configFile: false,
    logLevel: "error",
    build: { outDir: output },
    preview: {
      host: "127.0.0.1",
      port: 0,
      headers: { "Content-Security-Policy": policy },
    },
  });
  const origin = `http://127.0.0.1:${host.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });

  async function open(engine) {
    const page = await browser.newPage();
    const state = { requests: [], errors: [], warnings: [] };
    page.on("request", (request) => state.requests.push(new URL(request.url()).pathname));
    page.on("pageerror", (error) => state.errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) state.warnings.push(message.text());
    });
    await page.goto(`${origin}/code-highlight.html${engine ? `?engine=${engine}` : ""}`);
    return { page, state };
  }

  // The JavaScript engine highlights under the strict policy and never fetches WebAssembly.
  const javascript = await open("javascript");
  failures.push(javascript.state);
  await javascript.page.waitForFunction(
    () => document.querySelectorAll(".topik-rich-code-block pre.shiki").length === 2,
  );
  assert.ok(
    (await javascript.page.locator("pre.shiki code span[style]").count()) > 3,
    "code is highlighted with the JavaScript engine",
  );
  assert.equal(
    javascript.state.requests.some((path) => path.endsWith(`/${wasmChunk.fileName}`)),
    false,
    "the JavaScript engine must not load the WebAssembly chunk",
  );
  const loadedThemes = javascript.state.requests.filter((path) =>
    themes.some((chunk) => path.endsWith(`/${chunk.fileName}`)),
  );
  assert.equal(loadedThemes.length, 1, "only the active theme is fetched");
  assert.deepEqual(javascript.state.errors, []);
  assert.equal(
    javascript.state.warnings.some((text) => /Content Security Policy|wasm/iu.test(text)),
    false,
  );
  await javascript.page.close();

  // The default WebAssembly engine is refused by the same policy and degrades to plain code.
  const oniguruma = await open();
  failures.push(oniguruma.state);
  await oniguruma.page.waitForFunction(
    () => document.querySelectorAll(".topik-rich-code-block pre code").length === 2,
  );
  for (let attempt = 0; ; attempt++) {
    if (oniguruma.state.warnings.some((text) => text.includes("using plain code"))) break;
    assert.ok(attempt < 150, "the refused WebAssembly engine must fall back to plain code");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(oniguruma.state.requests.some((path) => path.endsWith(`/${wasmChunk.fileName}`)));
  assert.equal(await oniguruma.page.locator("pre.shiki").count(), 0);
  assert.deepEqual(oniguruma.state.errors, []);
  await oniguruma.page.close();

  console.log(
    `Verified Shiki emits ${themes.length} theme and ${languages.length} language chunks, ` +
      "and the JavaScript engine highlights without WebAssembly under a strict CSP",
  );
} catch (error) {
  console.error("Code highlight browser diagnostics", failures);
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
