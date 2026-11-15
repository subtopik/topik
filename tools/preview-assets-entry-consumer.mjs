import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A single-page app creates the preview asset adapter in its entry and loads the renderer later.
// The entry must stay free of the Markdown compiler and the renderer.
const { build } = await import(pathToFileURL(process.argv[2]).href);
const root = import.meta.dirname;
const html = join(root, "preview-assets-entry.html");
const app = join(root, "preview-assets-entry-app.js");
const article = join(root, "preview-assets-entry-article.js");
const output = join(root, "preview-assets-entry-dist");
// Compiler and renderer modules, whether bundled into @topik/content or kept as packages.
const heavy =
  /micromark|mdast-util|[\\/]@topik[\\/](?:content|remark-tags)[\\/]|[\\/]@topik[\\/]content-react[\\/]dist[\\/](?:render|theme|rich)[-.]/u;
const previewModule = /[\\/]@topik[\\/]content-react[\\/]dist[\\/]preview-assets-/u;

await writeFile(
  html,
  '<div id="root"></div><script type="module" src="/preview-assets-entry-app.js"></script>',
);
await writeFile(
  app,
  `import { createPreviewAssetAdapter } from "@topik/content-react/preview-assets";
export const store = { createAdapter: createPreviewAssetAdapter };
export const loadArticle = () => import("./preview-assets-entry-article.js");
window.topikPreviewStore = { store, loadArticle };
`,
);
await writeFile(
  article,
  `export { compileTopikContent, renderTopikContent } from "@topik/content-react";
export { defaultTopikComponents } from "@topik/content-react/theme";
`,
);
try {
  let chunks;
  await build({
    root,
    configFile: false,
    logLevel: "error",
    build: { outDir: output, emptyOutDir: true, rollupOptions: { input: html } },
    plugins: [
      {
        name: "topik-entry-graph",
        generateBundle(_, bundle) {
          chunks = Object.values(bundle).filter((file) => file.type === "chunk");
        },
      },
    ],
  });
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entry = chunks.find((chunk) => chunk.isEntry);
  assert.ok(entry, "the app build must have an entry chunk");
  // Everything the browser loads before the lazy import runs.
  const eager = new Set([entry.fileName]);
  for (const file of eager) for (const imported of byName.get(file).imports) eager.add(imported);
  const eagerChunks = [...eager].map((file) => byName.get(file));
  const eagerModules = eagerChunks.flatMap((chunk) => chunk.moduleIds);
  assert.ok(
    eagerModules.some((id) => previewModule.test(id)),
    "the entry must contain the preview asset adapter",
  );
  const leaked = eagerModules.filter((id) => heavy.test(id));
  assert.deepEqual(leaked, [], "the entry chunk must not contain the compiler or the renderer");
  const lazy = chunks.filter((chunk) => !eager.has(chunk.fileName));
  assert.ok(
    lazy.some((chunk) => chunk.moduleIds.some((id) => heavy.test(id))),
    "the renderer must remain available through the lazy app module",
  );
  // One adapter module instance: adapters created in the entry are admitted by the renderer.
  assert.equal(
    chunks.flatMap((chunk) => chunk.moduleIds).filter((id) => previewModule.test(id)).length,
    1,
  );
  const bytes = eagerChunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0);
  const gzip = eagerChunks.reduce((total, chunk) => total + gzipSync(chunk.code).byteLength, 0);
  console.log(
    `Verified the preview-assets entry excludes the compiler and renderer (${bytes} bytes, ${gzip} gzip)`,
  );
} finally {
  await rm(html, { force: true });
  await rm(app, { force: true });
  await rm(article, { force: true });
  await rm(output, { recursive: true, force: true });
}
