import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A browser app that statically imports one small @topik/content utility and
// loads the compiler from a lazy module must not pull the Markdown compiler
// into its entry. Bundlers place each module in exactly one chunk, so this
// only holds while the package is published as separate modules. (A direct
// `import("@topik/content")` beside a static import cannot split in any
// bundler: both name the same module, which is already in the entry chunk.)
const { build } = await import(pathToFileURL(process.argv[2]).href);
const root = import.meta.dirname;
const directory = await mkdtemp(join(root, "content-chunk-"));
const compilerModule =
  /[\\/]node_modules[\\/](?:micromark|mdast-util|@topik[\\/]remark-tags[\\/])/u;
try {
  const entry = join(directory, "entry.js");
  await writeFile(
    entry,
    `import { isTopikGeneratedAssetName } from "@topik/content";
export const generated = isTopikGeneratedAssetName("auto-v1-" + "a".repeat(52));
export const compile = () => import("./compiler.js").then(({ compileTopikContent }) => compileTopikContent);
`,
  );
  await writeFile(
    join(directory, "compiler.js"),
    'export { compileTopikContent } from "@topik/content";\n',
  );
  const result = await build({
    root: directory,
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: false,
      modulePreload: false,
      rollupOptions: { input: entry, preserveEntrySignatures: "exports-only" },
    },
  });
  const chunks = (Array.isArray(result) ? result : [result])
    .flatMap((output) => output.output)
    .filter((item) => item.type === "chunk");
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entryChunk = chunks.find((chunk) => chunk.isEntry);
  assert.ok(entryChunk, "The consumer build produced no entry chunk");
  // Everything the browser must evaluate before the entry runs.
  const initial = new Set();
  const visit = (chunk) => {
    if (initial.has(chunk)) return;
    initial.add(chunk);
    for (const name of chunk.imports) visit(byName.get(name));
  };
  visit(entryChunk);
  const initialModules = [...initial].flatMap((chunk) => chunk.moduleIds);
  const allModules = chunks.flatMap((chunk) => chunk.moduleIds);
  const initialBytes = [...initial].reduce((total, chunk) => total + chunk.code.length, 0);
  assert.ok(
    allModules.some((id) => compilerModule.test(id)),
    "The lazy compiler import was not bundled",
  );
  const eager = initialModules.filter((id) => compilerModule.test(id));
  assert.deepEqual(
    eager,
    [],
    `Importing one @topik/content utility loads the Markdown compiler with the entry (${initialBytes} bytes)`,
  );
  console.log(
    `Verified @topik/content keeps the compiler out of a utility-only entry (${initialBytes} bytes initial, ${chunks.length} chunks)`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
