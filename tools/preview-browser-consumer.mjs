import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { TOPIK_PREVIEW_PROTOCOL } from "@topik/core/preview";

// Run from an installed public cohort. Browser tooling is supplied by the test runner.
const { createServer } = await import(pathToFileURL(process.argv[2]).href);
const playwrightModule = await import(pathToFileURL(process.argv[3]).href);
const { chromium } = playwrightModule.default ?? playwrightModule;
const root = import.meta.dirname;
const dir = await mkdtemp(join(tmpdir(), "topik-preview-consumer-"));
const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const downloadBytes = Buffer.from("download bytes\n");
const configuration = (pages = ["z", "a"]) =>
  JSON.stringify({
    sourceVersion: 1,
    id: "course",
    title: "Course",
    slug: "course",
    modules: [{ id: "module", title: "Module", slug: "module", order: 0, pages }],
  });
await writeFile(
  join(dir, ".topik.yaml"),
  JSON.stringify({
    version: 1,
    namespace: "preview-consumer",
    sources: [{ kind: "course", config: "course.yaml" }],
  }),
);
await writeFile(join(dir, "course.yaml"), configuration());
await writeFile(join(dir, "hero.png"), png);
await writeFile(join(dir, "dark.png"), png);
await writeFile(join(dir, "download.txt"), downloadBytes);
await writeFile(
  join(dir, "z.md"),
  '---\nid: z-page\ntitle: Z\nslug: z\norder: 0\n---\n# Z\n\n![Hero](hero.png)\n\n{% figure src="hero.png" darkSrc="dark.png" alt="Figure" /%}\n\n[Download](download.txt)\n',
);
await writeFile(join(dir, "a.md"), "---\nid: a-page\ntitle: A\nslug: a\norder: 0\n---\n# A\n");
const host = await createServer({
  root,
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
await host.listen();
const allowedOrigin = `http://127.0.0.1:${host.httpServer.address().port}`;
const cli = spawn(
  process.execPath,
  [
    join(root, "node_modules/@topik/cli/dist/cli.mjs"),
    "dev",
    dir,
    "--port",
    "0",
    "--allow-origin",
    allowedOrigin,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
cli.stderr.on("data", (chunk) => {
  output += chunk;
});
const origin = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`CLI did not start: ${output}`)), 15000);
  cli.stdout.on("data", (chunk) => {
    output += chunk;
    const match = /Dev server listening on http:\/\/localhost:(\d+)/u.exec(output);
    if (match) {
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${match[1]}`);
    }
  });
  cli.once("exit", () => {
    clearTimeout(timeout);
    reject(new Error(`CLI exited: ${output}`));
  });
});
let browser;
try {
  assert.equal(TOPIK_PREVIEW_PROTOCOL, "topik-preview/1");
  assert.deepEqual((await (await fetch(`${origin}/health`)).json()).capabilities, [
    TOPIK_PREVIEW_PROTOCOL,
  ]);
  await writeFile(
    join(root, "preview.html"),
    '<div id="root"></div><script type="module" src="/preview-app.jsx"></script>',
  );
  await writeFile(
    join(root, "preview-app.jsx"),
    `
import React from "react";
import { createRoot } from "react-dom/client";
import { compileTopikContent, renderTopikContent, createPreviewAssetAdapter } from "@topik/content-react";
import { defaultTopikComponents } from "@topik/content-react/theme";
const origin = ${JSON.stringify(origin)};
const root = createRoot(document.getElementById("root"));
window.states = [];
let adapter;
let latest;
window.accept = state => {
  if (latest && latest.sessionId === state.sessionId && state.sequence <= latest.sequence) return;
  latest = state; window.latest = state; window.states.push(state);
  if (state.status !== "ready") return;
  adapter?.dispose();
  adapter = createPreviewAssetAdapter({ origin, snapshot: state });
  const page = state.resources.find(r => r.type === "CoursePage" && r.name === "z-page");
  root.render(page ? renderTopikContent(compileTopikContent(page.spec.content.value), { previewAssets: adapter, components: defaultTopikComponents }) : React.createElement("p", {}, "No pages"));
};
window.dispose = () => { root.unmount(); adapter?.dispose(); window.stream.close(); };
window.stream = new EventSource(origin + "/events");
window.stream.addEventListener("preview-state", event => window.accept(JSON.parse(event.data)));
`,
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (request) => {
    if (request.url().startsWith(`${origin}/blobs/`)) requests.push(request);
  });
  await page.goto(`${allowedOrigin}/preview.html`);
  await page.waitForFunction(
    () =>
      document.querySelectorAll("img").length === 2 &&
      [...document.querySelectorAll("img")].every((img) => img.naturalWidth === 1),
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.querySelector("picture img").naturalWidth === 1);
  const promisedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const downloaded = await promisedDownload;
  assert.deepEqual(await readFile(await downloaded.path()), downloadBytes);
  assert.equal(await page.locator("a[href^='blob:'], a[href^='http://127.0.0.1']").count(), 0);
  assert.ok(requests.length >= 2);
  for (const request of requests) {
    assert.equal((await request.allHeaders()).origin, allowedOrigin);
    const url = new URL(request.url());
    assert.ok(url.searchParams.get("sessionId"));
    assert.equal(url.searchParams.get("generation"), "1");
  }
  const first = await page.evaluate(() => window.latest);
  await writeFile(join(dir, "course.yaml"), configuration(["a", "z"]));
  await page.waitForFunction(
    (generation) => window.latest.status === "ready" && window.latest.generation > generation,
    first.generation,
  );
  const reordered = await page.evaluate(() => window.latest);
  assert.deepEqual(reordered.resources, first.resources);
  assert.equal(reordered.courseNavigation.course.modules[0].pages[0].name, "a-page");
  // Delayed HTTP snapshots cannot roll this example consumer back after an SSE commit.
  await page.evaluate((state) => window.accept(state), first);
  assert.equal(await page.evaluate(() => window.latest.sequence), reordered.sequence);
  await writeFile(join(dir, "course.yaml"), "title: [invalid");
  await page.waitForFunction(() => window.latest.status === "error");
  const failed = await page.evaluate(() => window.latest);
  assert.equal(failed.generation, reordered.generation);
  assert.deepEqual(failed.courseNavigation, reordered.courseNavigation);
  await page.evaluate(() => window.stream.close());
  await page.evaluate((origin) => {
    window.stream = new EventSource(origin + "/events");
    window.stream.addEventListener("preview-state", (event) => {
      window.reconnected = JSON.parse(event.data);
    });
  }, origin);
  await page.waitForFunction(() => window.reconnected?.status === "error");
  assert.deepEqual(await page.evaluate(() => window.reconnected), failed);
  await page.evaluate(() =>
    window.stream.addEventListener("preview-state", (event) =>
      window.accept(JSON.parse(event.data)),
    ),
  );
  await writeFile(join(dir, "course.yaml"), configuration(["a", "z"]));
  await page.waitForFunction(
    (generation) => window.latest.status === "ready" && window.latest.generation > generation,
    failed.generation,
  );
  // Signature-only PNGs pass media sniffing but must surface browser decode failure.
  const beforeDecodeFailure = await page.evaluate(() => window.latest.generation);
  await writeFile(join(dir, "hero.png"), png.subarray(0, 8));
  await writeFile(join(dir, "dark.png"), png.subarray(0, 8));
  await page.waitForFunction(
    (generation) => window.latest.status === "ready" && window.latest.generation > generation,
    beforeDecodeFailure,
  );
  await page.waitForFunction(() => document.querySelectorAll('[role="alert"]').length === 2);
  assert.equal(await page.getByRole("heading", { name: "Z", exact: true }).count(), 1);
  assert.equal(await page.locator("img").count(), 0);
  const beforeDecodeRecovery = await page.evaluate(() => window.latest.generation);
  await writeFile(join(dir, "hero.png"), png);
  await writeFile(join(dir, "dark.png"), png);
  await page.waitForFunction(
    (generation) =>
      window.latest.status === "ready" &&
      window.latest.generation > generation &&
      document.querySelectorAll("img").length === 2 &&
      [...document.querySelectorAll("img")].every((img) => img.naturalWidth === 1),
    beforeDecodeRecovery,
  );
  assert.equal(await page.getByRole("alert").count(), 0);
  await writeFile(join(dir, "course.yaml"), configuration([]));
  await page.getByText("No pages", { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.latest.resources)).filter((r) => r.type === "CoursePage")
      .length,
    0,
  );
  const payloadPath = first.payloads[0].path;
  assert.equal((await fetch(`${origin}/${payloadPath}?sessionId=other&generation=1`)).status, 409);
  assert.equal(
    (await fetch(`${origin}/${payloadPath}`, { headers: { Origin: "https://evil.test" } })).status,
    403,
  );
  await page.evaluate(() => window.dispose());
  console.log(
    "Verified packed CLI preview feed and browser image, light/dark figure, download and recovery integration",
  );
} finally {
  await browser?.close();
  cli.kill("SIGINT");
  await once(cli, "exit");
  await host.close();
  await rm(dir, { recursive: true, force: true });
  await rm(join(root, "preview.html"), { force: true });
  await rm(join(root, "preview-app.jsx"), { force: true });
}
