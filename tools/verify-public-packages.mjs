import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { packPublicPackages } from "./pack-public-package.mjs";
import { listNpmRootMetadata } from "./public-packlist.mjs";
import { publicPackages } from "./publish-alpha.mjs";

const root = join(import.meta.dirname, "..");
// Build, pack, and type-check on the toolchain runtime. Optionally execute the
// same installed artifacts on an older public runtime without loading Vitest.
const { values } = parseArgs({ options: { "runtime-node": { type: "string" } } });
const runtimeNodes = [...new Set([process.execPath, values["runtime-node"]].filter(Boolean))];
const temporary = mkdtempSync(join(tmpdir(), "topik-public-packages-"));

try {
  const consumer = join(temporary, "consumer");
  mkdirSync(consumer);
  const { archives, cohortVersion } = packPublicPackages(root, join(temporary, "packing"));
  const manifests = new Map();

  for (const packageName of publicPackages) {
    const archive = archives.get(packageName);
    if (archive === undefined) throw new Error(`No archive was produced for ${packageName}`);
    const packageRoot = join(root, "packages", packageName.slice("@topik/".length));
    verifyPacklist(packageRoot, archive);
    manifests.set(packageName, readPackedManifest(archive));
  }
  verifyCohort(manifests, cohortVersion);

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          publicPackages.map((packageName) => [packageName, `file:${archives.get(packageName)}`]),
        ),
        devDependencies: { typescript: lockedTypescriptVersion() },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("npm", ["install", "--ignore-scripts"], {
    cwd: consumer,
    stdio: "inherit",
  });
  execFileSync("npm", ["audit", "--omit=dev"], { cwd: consumer, stdio: "inherit" });

  const modules = join(consumer, "node_modules");
  const modulesBoundary = `${realpathSync(modules)}${sep}`;
  for (const packageName of publicPackages) {
    const packageRoot = join(root, "packages", packageName.slice("@topik/".length));
    const destination = join(modules, packageName);
    if (
      lstatSync(destination).isSymbolicLink() ||
      !realpathSync(destination).startsWith(modulesBoundary)
    ) {
      throw new Error(`${packageName} is not installed inside the clean consumer`);
    }
    const installedManifest = readJson(join(destination, "package.json"));
    const packedManifest = manifests.get(packageName);
    if (JSON.stringify(installedManifest) !== JSON.stringify(packedManifest)) {
      throw new Error(`${packageName} installed manifest differs from its packed manifest`);
    }
    verifyManifest(packageName, destination, installedManifest);
    if (
      readFileSync(join(destination, "LICENSE"), "utf8") !==
      readFileSync(join(packageRoot, "LICENSE"), "utf8")
    ) {
      throw new Error(`${packageName} packed license differs from its declared package license`);
    }
  }

  verifyConsumer(consumer);
  const sourceFixture = join(consumer, "source-writeback.mjs");
  copyFileSync(join(root, "tools/source-writeback-consumer.mjs"), sourceFixture);
  for (const runtime of runtimeNodes)
    execFileSync(runtime, [sourceFixture], { cwd: consumer, stdio: "inherit", timeout: 30_000 });
  const contentManifest = readJson(join(modules, "@topik/content/package.json"));
  if (contentManifest.dependencies?.["linkify-it"]) {
    throw new Error("Packed content must not depend on implicit autolinking");
  }
  if (contentManifest.inlinedDependencies?.["micromark-extension-gfm-autolink-literal"]) {
    throw new Error("Packed content must not bundle the former GFM autolinker");
  }
  verifyDeclarations(consumer);
  verifyDocumentationExamples(consumer);
  verifyBins(modules);
  console.log(`Verified packed public package cohort ${cohortVersion}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function verifyCohort(manifests, cohortVersion) {
  if (typeof cohortVersion !== "string" || !/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(cohortVersion)) {
    throw new Error("Public packages do not expose one alpha cohort version");
  }
  for (const [packageName, manifest] of manifests) {
    if (manifest.version !== cohortVersion) {
      throw new Error(`${packageName} is outside the ${cohortVersion} public cohort`);
    }
    for (const dependencies of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [dependency, version] of Object.entries(dependencies ?? {})) {
        if (version.startsWith("catalog:") || version.startsWith("workspace:")) {
          throw new Error(`${packageName} packs unresolved metadata for ${dependency}`);
        }
      }
    }
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@topik/") && version !== cohortVersion) {
        throw new Error(`${packageName} does not pin ${dependency} to ${cohortVersion}`);
      }
    }
  }
}

function verifyPacklist(packageRoot, archive) {
  const actual = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
    .map((entry) => entry.replace(/^package\//u, ""))
    .toSorted((left, right) => left.localeCompare(right));
  const expected = [
    "package.json",
    ...listNpmRootMetadata(packageRoot),
    ...listFiles(join(packageRoot, "dist"), "dist"),
  ].toSorted((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected packed files for ${packageRoot}: ${actual.join(", ")}`);
  }
}

function listFiles(directory, prefix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? listFiles(path, relativePath) : [relativePath];
  });
}

function verifyManifest(packageName, destination, manifest) {
  if (manifest.name !== packageName || manifest.private === true || manifest.license !== "MIT") {
    throw new Error(`${packageName} packed manifest has invalid public metadata`);
  }
  if (
    !Array.isArray(manifest.files) ||
    JSON.stringify(manifest.files) !== JSON.stringify(["dist"])
  ) {
    throw new Error(`${packageName} packed manifest has an unexpected files boundary`);
  }
  for (const target of exportTargets(manifest.exports)) {
    if (target.includes("/src/") || target.startsWith("./src/")) {
      throw new Error(`${packageName} exposes repository source through ${target}`);
    }
    if (target.includes("*")) continue;
    if (!statSync(join(destination, target)).isFile()) {
      throw new Error(`${packageName} export target is missing: ${target}`);
    }
    if (target.endsWith(".mjs")) {
      const declaration = target.replace(/\.mjs$/u, ".d.mts");
      if (!statSync(join(destination, declaration)).isFile()) {
        throw new Error(`${packageName} declaration target is missing: ${declaration}`);
      }
    }
  }
  for (const target of Object.values(manifest.bin ?? {})) {
    if (typeof target !== "string" || !statSync(join(destination, target)).isFile()) {
      throw new Error(`${packageName} packed bin target is missing`);
    }
  }
  for (const file of listFiles(join(destination, "dist"), "dist")) {
    if (!/\.(?:mjs|mts)$/u.test(file)) continue;
    const content = readFileSync(join(destination, file), "utf8");
    if (content.includes(root)) {
      throw new Error(`${packageName} embeds its workspace path in ${file}`);
    }
  }
}

function exportTargets(exports) {
  if (typeof exports === "string") return [exports];
  if (exports === null || typeof exports !== "object") return [];
  return Object.values(exports).flatMap((value) => exportTargets(value));
}

function verifyConsumer(consumer) {
  const script = join(consumer, "runtime.mjs");
  writeFileSync(
    script,
    `import assert from "node:assert/strict";
import { parseDocument, writeDocument, evaluateDocument, compileTopikContent, isContentTag, validateTopikContent, formatTopikContent, sameDocumentMeaning, TOPIK_CONTENT_SCHEMA_VERSION } from "@topik/content";
import remarkTags, { remarkTags as namedRemarkTags } from "@topik/remark-tags";
import { isGeneratedAssetName, validateResources } from "@topik/core";
import { resolveWikiNavigation, resolveWikiContentHref, resolveWikiContentReference } from "@topik/core/wiki-navigation";
import { resolveCourseNavigation, resolveCourseContentHref, resolveCourseContentReference } from "@topik/core/course-navigation";
import { renderTopikMarkdown } from "@topik/content-react";
import * as rich from "@topik/content-react/rich";
import * as theme from "@topik/content-react/theme";
import guideSchema from "@topik/schema/guide/v1.json" with { type: "json" };
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const modulePrefix = new URL("./node_modules/", import.meta.url).href;
const topikPrefix = new URL("./node_modules/@topik/", import.meta.url).href;
for (const specifier of ["@topik/remark-tags", "@topik/content", "@topik/core", "@topik/core/wiki-navigation", "@topik/core/course-navigation", "@topik/content-react", "@topik/content-react/rich", "@topik/content-react/theme", "@topik/schema/guide/v1.json"]) {
  assert.ok(import.meta.resolve(specifier).startsWith(topikPrefix), specifier + " resolved outside the packed cohort");
}
assert.ok(import.meta.resolve("react-dom/server").startsWith(modulePrefix), "react-dom resolved outside the clean consumer");
assert.equal(guideSchema.properties.type.const, "Guide");
const wikiLinks = resolveWikiNavigation([{type: "page", page: "home", slug: "", title: "Home", sourcePath: "index"}, {type: "page", page: "setup", slug: "install", title: "Setup", sourcePath: "setup"}], {sourceVersion: 1});
assert.equal(resolveWikiContentHref("./setup.md?mode=full#start", "home", wikiLinks)?.page.page, "setup");
assert.equal(resolveWikiContentReference("./missing.md", "home", wikiLinks).kind, "unresolved");
const courseLinks = resolveCourseNavigation({course: "training", modules: [{name: "foundations", slug: "foundations"}], pages: [{name: "intro", module: "foundations", slug: "introduction", sourcePath: "lessons/intro"}, {name: "next", module: "foundations", slug: "next", sourcePath: "lessons/next"}]});
assert.equal(resolveCourseContentHref("next.md?mode=read#topic", "intro", courseLinks)?.page.page, "next");
assert.equal(resolveCourseContentHref("/foundations/next", "intro", courseLinks)?.route, "foundations/next");
assert.equal(resolveCourseContentReference("missing.md", "intro", courseLinks).kind, "unresolved");
const headingOne = parseDocument("# Heading {% #one %}");
const headingTwo = parseDocument("# Heading {% #two %}");
assert.ok(headingOne.ok && headingTwo.ok);
assert.equal(sameDocumentMeaning(headingOne.document, headingTwo.document), false);
assert.equal(validateTopikContent("# Packed").valid, true);
assert.equal(validateTopikContent("{% unknown /%}").valid, false);
// Verify declared text/link intent independently of round-trip stability.
const markedUrl = parseDocument("https://example.test/a*b*c");
assert.equal(markedUrl.ok, true);
assert.equal(markedUrl.document.children[0].children[0].type, "text");
assert.equal(markedUrl.document.children[0].children[0].value, "https://example.test/a");
assert.equal(markedUrl.document.children[0].children[1].type, "emphasis");
const plainDocument = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "https://example.test www.example.com person@example.com" }] }] };
const plainSource = plainDocument.children[0].children[0].value;
const plainParsed = parseDocument(plainSource);
assert.equal(plainParsed.ok, true);
assert.equal(plainParsed.document.children[0].children[0].type, "text");
assert.equal(plainParsed.document.children[0].children[0].value, plainSource);
assert.equal(writeDocument(plainDocument), plainSource + String.fromCharCode(10));
const linkRendering = { components: { TopikLink: ({ children, href }) => createElement("a", { href }, children) } };
const plainHtml = renderToStaticMarkup(renderTopikMarkdown(plainSource, linkRendering));
assert.ok(!plainHtml.includes("<a "), "Bare addresses must render as text");
const linkedHtml = renderToStaticMarkup(renderTopikMarkdown("<https://example.test>", linkRendering));
assert.ok(linkedHtml.includes('<a href="https://example.test">'), "Explicit links must render as anchors");
assert.equal(validateTopikContent("http://example.test").valid, true);
assert.equal(validateTopikContent("<http://example.test>").valid, false);
const linked = parseDocument("<https://example.test> <person@example.com>");
assert.equal(linked.ok, true);
assert.equal(linked.document.children[0].children[0].url, "https://example.test");
assert.equal(linked.document.children[0].children[2].url, "mailto:person@example.com");
const plainReopened = parseDocument(writeDocument(plainDocument));
assert.equal(plainReopened.ok, true);
assert.equal(plainReopened.document.children[0].children.length, 1);
assert.equal(plainReopened.document.children[0].children[0].type, "text");
assert.equal(plainReopened.document.children[0].children[0].value, plainDocument.children[0].children[0].value);
const nestedMarks = parseDocument("****https://example.test/a*b*c");
assert.equal(nestedMarks.ok, true);
const nestedReopened = parseDocument(writeDocument(nestedMarks.document));
assert.equal(nestedReopened.ok, true);
const withoutPositions = (key, value) => key === "position" ? undefined : value;
assert.deepEqual(JSON.parse(JSON.stringify(nestedReopened.document, withoutPositions)), JSON.parse(JSON.stringify(nestedMarks.document, withoutPositions)));
const unsupportedMarks = "****https://example.test/a*b*c*";
const marksRefused = parseDocument(unsupportedMarks);
assert.equal(marksRefused.ok, false);
assert.equal(marksRefused.source, unsupportedMarks);
assert.equal(marksRefused.diagnostics[0].id, "topik-mark-nesting");
// Verify the installed runtime preserves complete destinations and bounded work.
const longUrl = "https://example.test/" + "*".repeat(40000) + "end";
const unclosedLabel = "[ " + "Read http then ask member@office for more notes. ".repeat(6000);
for (const source of [longUrl, "<" + longUrl + ">", unclosedLabel]) {
  const start = performance.now();
  const parsed = parseDocument(source);
  const elapsed = performance.now() - start;
  assert.equal(parsed.ok, true);
  const child = parsed.document.children[0].children[0];
  if (source.startsWith("<")) {
    assert.equal(child.type, "link");
    assert.equal(child.url, longUrl);
  } else {
    assert.equal(child.type, "text");
    assert.equal(child.value, source.trimEnd());
  }
  assert.ok(elapsed < 1000, "Packed link parsing regression took " + elapsed + " ms");
}
// Keep the heavy parser-work regression in the actual runtime artifact. V8
// coverage instrumentation distorts code-span scanning time substantially.
const unmatchedCodeRuns = Array.from({ length: 1000 }, (_, index) => String.fromCharCode(96).repeat(index + 1) + "x").join(" ");
const codeRunStarted = performance.now();
const codeRunResult = parseDocument(unmatchedCodeRuns);
assert.equal(codeRunResult.ok, false);
assert.equal(codeRunResult.source, unmatchedCodeRuns);
assert.equal(codeRunResult.diagnostics[0].id, "topik-content-limit");
assert.ok(performance.now() - codeRunStarted < 5000, "Packed unmatched code runs exceeded the parser-work budget");
assert.equal(typeof remarkTags, "function");
assert.equal(remarkTags, namedRemarkTags);
assert.equal(TOPIK_CONTENT_SCHEMA_VERSION, "0.2.1");
// Establish template support in the installed cohort, beyond source-level tests.
const templateFence = String.fromCharCode(96).repeat(3);
const templateSource = [
  '{% callout title=t"Install {% $package.name %}" %}',
  '{% template code %}',
  templateFence + 'sh',
  'npm install {% $package.name %}@{% $package.version %}',
  'echo {%% $literal %}',
  templateFence,
  '{% /template code %}',
  '{% /callout %}',
  '',
  '{% figure src="./install.png" alt=t"{% $package.name %} installation" caption=t"Version {% $package.version %}" /%}',
  '',
  '{% callout title="Literal {% $missing %}" %}',
  'Ordinary attributes remain literal.',
  '{% /callout %}',
  '',
  templateFence + 'sh',
  'echo {% $missing %}',
  templateFence,
].join(String.fromCharCode(10));
const templateParsed = parseDocument(templateSource);
assert.equal(templateParsed.ok, true);
const authoredTemplate = templateParsed.document.children[0];
assert.equal(authoredTemplate.type, 'topikComponent');
assert.equal(authoredTemplate.props.title.type, 'topikTextTemplate');
assert.equal(authoredTemplate.children[0].type, 'topikCodeTemplate');
const templateSnapshot = JSON.stringify(templateParsed.document);
const templateFormatted = formatTopikContent(templateSource);
assert.equal(templateFormatted.ok, true);
assert.ok(templateFormatted.formatted.includes('title=t"Install {% $package.name %}"'));
assert.ok(templateFormatted.formatted.includes('echo {%% $literal %}'));
assert.equal(formatTopikContent(templateFormatted.formatted).formatted, templateFormatted.formatted);
const templateReopened = parseDocument(writeDocument(templateParsed.document));
assert.equal(templateReopened.ok, true);
assert.deepEqual(JSON.parse(JSON.stringify(templateReopened.document, withoutPositions)), JSON.parse(JSON.stringify(templateParsed.document, withoutPositions)));
const templateConfig = { variables: { package: { name: '<kit&>', version: '1.2.3' } } };
const templateCompiled = compileTopikContent(templateSource, { config: templateConfig });
assert.equal(templateCompiled.ok, true);
assert.equal(templateCompiled.source, templateSource);
const tags = [];
const collectTags = (node) => {
  if (Array.isArray(node)) return node.forEach(collectTags);
  if (isContentTag(node)) { tags.push(node); node.children.forEach(collectTags); }
};
collectTags(templateCompiled.tree);
assert.equal(tags.find((tag) => tag.name === 'TopikCallout').attributes.title, 'Install <kit&>');
assert.equal(tags.find((tag) => tag.name === 'TopikFigure').attributes.alt, '<kit&> installation');
assert.equal(tags.find((tag) => tag.name === 'TopikFigure').attributes.caption, 'Version 1.2.3');
assert.equal(tags.find((tag) => tag.name === 'TopikCodeBlock').attributes.content, 'npm install <kit&>@1.2.3\\necho {% $literal %}\\n');
assert.equal(tags.filter((tag) => tag.name === 'TopikCodeBlock')[1].attributes.content, 'echo {% $missing %}\\n');
const templateEvaluated = evaluateDocument(templateParsed.document, templateConfig.variables);
assert.equal(templateEvaluated.children[0].props.title, 'Install <kit&>');
assert.equal(templateEvaluated.children[0].children[0].type, 'code');
assert.equal(JSON.stringify(templateParsed.document), templateSnapshot);
const templateHtml = renderToStaticMarkup(renderTopikMarkdown(templateSource, { config: templateConfig, components: theme.defaultTopikComponents }));
assert.ok(templateHtml.includes('Install &lt;kit&amp;&gt;'));
assert.ok(templateHtml.includes('npm install &lt;kit&amp;&gt;@1.2.3'));
assert.ok(!templateHtml.includes('&amp;lt;kit'), 'Template values must not be pre-escaped');
const templateRichHtml = renderToStaticMarkup(createElement(rich.RichTopikContentProvider, { theme: 'light' }, createElement(theme.TopikContent, { content: templateSource, config: templateConfig })));
assert.ok(templateRichHtml.includes('npm install &lt;kit&amp;&gt;@1.2.3'));
for (const [source, variables, diagnostic] of [
  ['{% callout title=t"{% $missing %}" %}\\nBody\\n{% /callout %}', {}, 'topik-template-variable-missing'],
  ['{% callout title=t"{% $name %}" %}\\nBody\\n{% /callout %}', { name: 'two\\nlines' }, 'topik-template-control'],
]) {
  const failed = compileTopikContent(source, { config: { variables } });
  assert.equal(failed.ok, false);
  assert.equal(failed.source, source);
  assert.equal(failed.diagnostics[0].id, diagnostic);
  assert.equal('tree' in failed, false);
}
const conditional = '{% if $teacher %}\\nTeacher\\n{% else /%}\\nHello {% $name %}\\n{% /if %}';
assert.equal(formatTopikContent(conditional).ok, true);
const personalized = renderToStaticMarkup(renderTopikMarkdown(conditional, {config: {variables: {teacher: false, name: "Ada"}}}));
assert.match(personalized, /Hello Ada/u);
assert.doesNotMatch(personalized, /Teacher/u);
assert.equal(isGeneratedAssetName("auto-v1-" + "a".repeat(52)), true);
assert.deepEqual(validateResources([{ apiVersion: "v1", type: "Guide", name: "packed", spec: { title: "Packed", slug: "packed", content: { format: "topik", value: "# Packed" } } }]), { valid: true, errors: [] });
assert.deepEqual(validateResources([{ apiVersion: "v2", type: "Guide", name: "packed", spec: {} }]).errors, [{ id: "resource-unsupported-version", resource: "Guide/packed", path: "/apiVersion", message: "Unsupported Guide apiVersion: v2" }]);
assert.match(renderToStaticMarkup(renderTopikMarkdown("# Packed")), /<h1 id="packed">Packed<\\/h1>/u);
assert.equal(typeof rich.RichTopikContentProvider, "function");
assert.equal(typeof theme.TopikContent, "function");
`,
  );
  for (const runtime of runtimeNodes) {
    console.log(
      `Checking packed runtime with ${execFileSync(runtime, ["--version"], { encoding: "utf8" }).trim()}`,
    );
    execFileSync(runtime, [script], {
      cwd: consumer,
      stdio: "inherit",
      timeout: 30_000,
    });
  }
}

function verifyDeclarations(consumer) {
  const fixture = join(consumer, "types.mts");
  writeFileSync(
    fixture,
    `import type { Guide } from "@topik/schema/guide/v1";
import { validateTopikContent } from "@topik/content";
import { validateResources } from "@topik/core";
import { renderTopikMarkdown } from "@topik/content-react";
import { RichTopikContentProvider } from "@topik/content-react/rich";
import { TopikContent } from "@topik/content-react/theme";

const guide: Guide = { apiVersion: "v1", type: "Guide", name: "packed", spec: { title: "Packed", slug: "packed", content: { format: "topik", value: "# Packed" } } };
validateTopikContent(guide.spec.content.value);
validateResources([guide]);
renderTopikMarkdown(guide.spec.content.value);
void RichTopikContentProvider;
void TopikContent;
`,
  );
  const config = join(consumer, "tsconfig.json");
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
          types: [],
        },
        files: ["types.mts"],
      },
      null,
      2,
    )}\n`,
  );
  const compiler = join(consumer, "node_modules", "typescript", "bin", "tsc");
  const consumerBoundary = `${realpathSync(consumer)}${sep}`;
  if (!realpathSync(compiler).startsWith(consumerBoundary)) {
    throw new Error("TypeScript is not installed inside the clean consumer");
  }
  execFileSync(process.execPath, [compiler, "--project", config], {
    cwd: consumer,
    stdio: "inherit",
  });

  // A simple import smoke test misses declaration bundlers that detach our
  // custom node maps from mdast. Exercise real AST narrowing and construction
  // with library checking enabled, against the npm-installed artifacts.
  const contentFixture = join(consumer, "content-types.mts");
  writeFileSync(
    contentFixture,
    `import { parseDocument, mergeTopikContentConfig, validateTopikContent, type AuthoredAttributeValue, type CodeTemplate, type TextTemplate, type Component, type ComponentSchema, type ContentDocument, type TopikContentConfig } from "@topik/content";
import type { TagContainerNode, TagTextNode } from "@topik/remark-tags";
import type { RootContent } from "mdast";

const notice: ComponentSchema = {
  kind: "block", render: "Notice", attributes: {}, children: "blocks",
};
const config: TopikContentConfig = { components: { notice } };
const resolved = mergeTopikContentConfig(config);
validateTopikContent("Text", { config });
validateTopikContent("Text", { config: resolved });
const invalidConfig: TopikContentConfig = {
  components: {
    notice: {
      ...notice,
      // @ts-expect-error Custom schemas are declarative, without runtime callbacks.
      validate: () => [],
    },
  },
};
void invalidConfig;

const parsed = parseDocument("Hello {% $reader.name %}");
if (parsed.ok) {
  for (const node of parsed.document.children) {
    if (node.type === "topikConditional") {
      const branches = node.children;
      void branches;
    }
    if (node.type === "topikCodeTemplate") {
      const template: TextTemplate = node.template;
      const language: string | null | undefined = node.lang;
      void template; void language;
    }
    if (node.type === "paragraph") {
      for (const child of node.children) {
        if (child.type === "topikVariable") {
          const path: string[] = child.path;
          const line: number | undefined = child.position?.start.line;
          void path; void line; void child.data;
        }
        if (child.type === "topikComponent") {
          const name: string = child.name;
          const line: number | undefined = child.position?.start.line;
          void name; void line; void child.data;
        }
      }
    }
  }
}
const component: Component = {
  type: "topikComponent", name: "badge", props: {},
  children: [{ type: "text", value: "Ready" }],
};
const template: TextTemplate = {
  type: "topikTextTemplate",
  segments: [{ type: "literal", value: "Install " }, { type: "variable", path: ["package", "name"] }],
};
const title: AuthoredAttributeValue = template;
const codeTemplate: CodeTemplate = {
  type: "topikCodeTemplate", lang: "sh", meta: null,
  template: { type: "topikTextTemplate", segments: [{ type: "variable", path: ["command"] }] },
};
const templateComponent: Component = {
  type: "topikComponent", name: "callout", props: { title }, children: [codeTemplate],
};
const document: ContentDocument = {
  type: "root", children: [{
    type: "topikConditional", children: [{
      type: "topikBranch", condition: { type: "literal", value: true },
      children: [{ type: "paragraph", children: [component] }],
    }],
  }],
};
const nestedInline: TagTextNode = {
  type: "tagText", name: "badge", children: [{
    type: "tagText", name: "badge", children: [],
  }],
};
const nestedBlock: TagContainerNode = {
  type: "tagContainer", name: "callout", children: [{
    type: "tagContainer", name: "callout", children: [],
  }],
};
const ecosystemNodes: RootContent[] = [component, templateComponent, codeTemplate, nestedInline, nestedBlock];
void document; void ecosystemNodes;
`,
  );
  for (const resolution of ["NodeNext", "Bundler"]) {
    writeFileSync(
      config,
      `${JSON.stringify(
        {
          compilerOptions: {
            module: resolution === "NodeNext" ? "NodeNext" : "ESNext",
            moduleResolution: resolution,
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: "ES2022",
            types: [],
          },
          files: ["content-types.mts"],
        },
        null,
        2,
      )}\n`,
    );
    execFileSync(process.execPath, [compiler, "--project", config], {
      cwd: consumer,
      stdio: "inherit",
    });
  }
}

function verifyDocumentationExamples(consumer) {
  const files = [
    ["content-readme", join(consumer, "node_modules/@topik/content/README.md")],
    ["source-writing", join(root, "docs/resources/source-writing.md")],
  ].flatMap(([prefix, path]) => {
    const markdown = readFileSync(path, "utf8");
    const examples = [...markdown.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((match) => match[1]);
    if (!examples.length) throw new Error(`${path} has no TypeScript examples`);
    return examples.map((source, index) => {
      const name = `${prefix}-${index}.mts`;
      writeFileSync(join(consumer, name), source);
      return name;
    });
  });
  const config = join(consumer, "readme-tsconfig.json");
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "readme-output",
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: [],
        },
        files,
      },
      null,
      2,
    )}\n`,
  );
  const compiler = join(consumer, "node_modules/typescript/bin/tsc");
  execFileSync(process.execPath, [compiler, "--project", config], {
    cwd: consumer,
    stdio: "inherit",
  });
  for (const file of files) {
    for (const runtime of runtimeNodes)
      execFileSync(runtime, [join(consumer, "readme-output", file.replace(/\.mts$/u, ".mjs"))], {
        cwd: consumer,
        stdio: "inherit",
        timeout: 30_000,
      });
  }
}

function verifyBins(modules) {
  for (const [packageName, bin, expected] of [
    ["cli", "topik", "Topik CLI"],
    ["codemod", "topik-codemod", "Codemods for migrating content to Topik"],
  ]) {
    const manifest = readJson(join(modules, "@topik", packageName, "package.json"));
    for (const runtime of runtimeNodes) {
      const output = execFileSync(
        runtime,
        [join(modules, "@topik", packageName, manifest.bin[bin]), "--help"],
        { encoding: "utf8" },
      );
      if (!output.includes(expected)) {
        throw new Error(`Packed ${bin} did not execute its public help boundary`);
      }
    }
  }
}

function readPackedManifest(archive) {
  return JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
  );
}

function lockedTypescriptVersion() {
  const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const match =
    /^    typescript:\r?\n      specifier: [^\r\n]+\r?\n      version: ['"]?([^'"\s]+)['"]?\r?$/mu.exec(
      lockfile,
    );
  if (match === null || !/^\d+\.\d+\.\d+$/u.test(match[1])) {
    throw new Error("The default catalog does not lock one exact TypeScript version");
  }
  return match[1];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
