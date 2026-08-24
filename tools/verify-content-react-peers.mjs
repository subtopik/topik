import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mode = process.argv[2];
if (mode !== "minimum" && mode !== "workspace") {
  throw new Error("Expected peer mode: minimum or workspace");
}

const root = join(import.meta.dirname, "..");
const contentReactRoot = join(root, "packages", "content-react");
const contentSchemaRoot = join(root, "packages", "content-schema");
const workspaceManifest = readJson(join(root, "package.json"));
const manifest = readJson(join(contentReactRoot, "package.json"));
const peerNames = ["katex", "mermaid", "react", "react-dom", "shiki"];
const peers = Object.fromEntries(
  peerNames.map((name) => [
    name,
    mode === "minimum"
      ? minimumVersion(manifest.peerDependencies[name])
      : readJson(join(workspaceModule(name), "package.json")).version,
  ]),
);
const temporary = mkdtempSync(join(tmpdir(), `topik-content-react-${mode}-`));

try {
  const archives = join(temporary, "archives");
  mkdirSync(archives);
  const contentSchemaArchive = pack(contentSchemaRoot, archives);
  const contentReactArchive = pack(contentReactRoot, archives);
  writeFileSync(
    join(temporary, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        packageManager: workspaceManifest.packageManager,
        dependencies: {
          "@topik/content-react": `file:${contentReactArchive}`,
          "@topik/content-schema": `file:${contentSchemaArchive}`,
          ...peers,
        },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("pnpm", ["install", "--ignore-scripts", "--lockfile=false"], {
    cwd: temporary,
    stdio: "inherit",
  });
  writeFileSync(
    join(temporary, "smoke.mjs"),
    `import assert from "node:assert/strict";
import { renderTopikMarkdown } from "@topik/content-react";
import { getRichTopikComponents } from "@topik/content-react/rich";
import { TopikContent } from "@topik/content-react/theme";
import katex from "katex";
import mermaid from "mermaid";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as shiki from "shiki";

const fence = String.fromCharCode(96).repeat(3);
const markdown = ["# Peer smoke", "", fence + "js", "const value = 1;", fence].join("\\n");
const html = renderToStaticMarkup(renderTopikMarkdown(markdown, { components: getRichTopikComponents() }));
assert.match(html, /id="peer-smoke"/u);
assert.match(html, /topik-rich-code/u);
assert.equal(typeof TopikContent, "function");
assert.match(renderToStaticMarkup(createElement(TopikContent, { content: "# Theme smoke" })), /id="theme-smoke"/u);
assert.equal(typeof katex.renderToString, "function");
assert.equal(typeof mermaid.initialize, "function");
assert.equal(typeof shiki.codeToHtml, "function");
`,
  );
  execFileSync(process.execPath, [join(temporary, "smoke.mjs")], {
    cwd: temporary,
    stdio: "inherit",
  });
  console.log(`Verified content-react ${mode} peers: ${JSON.stringify(peers)}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function minimumVersion(range) {
  const match = /^\^(\d+\.\d+\.\d+)$/u.exec(range);
  if (match === null) throw new Error(`Peer range does not expose one caret minimum: ${range}`);
  return match[1];
}

function workspaceModule(name) {
  const path = [
    join(contentReactRoot, "node_modules", name),
    join(root, "node_modules", name),
  ].find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error(`Workspace peer is unavailable: ${name}`);
  return realpathSync(path);
}

function pack(packageRoot, destination) {
  const before = new Set(readdirSync(destination));
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd: packageRoot,
    stdio: "ignore",
  });
  const archive = readdirSync(destination).find(
    (entry) => entry.endsWith(".tgz") && !before.has(entry),
  );
  if (archive === undefined) throw new Error(`No archive was produced for ${packageRoot}`);
  return join(destination, archive);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
