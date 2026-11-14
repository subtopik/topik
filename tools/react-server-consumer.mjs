// Run with `node --conditions=react-server`. A server-component bundler replaces every module
// that starts with "use client" by client references and never evaluates it. This loader does
// the same, so the packed root entry is checked the way a server component imports it.
import assert from "node:assert/strict";
import { register } from "node:module";

const clientReference = Symbol.for("react.client.reference");
const hooks = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (result.format !== "module") return result;
  const source = String(result.source);
  if (!/^\\s*["']use client["']/.test(source)) return result;
  const names = [...source.matchAll(/export\\s*\\{([^}]*)\\}/g)]
    .flatMap((match) => match[1].split(","))
    .map((entry) => entry.trim().split(/\\s+as\\s+/).at(-1))
    .filter(Boolean);
  if (names.length === 0) throw new Error("Client module without named exports: " + url);
  const stub = names
    .map((name) => "export const " + (name === "default" ? "__default" : name) +
      " = Object.defineProperties(function () { throw new Error('Client reference called on the server'); }, " +
      "{ $$typeof: { value: Symbol.for('react.client.reference') }, $$id: { value: " +
      JSON.stringify(url + "#" + name) + " } });" + (name === "default" ? " export default __default;" : ""))
    .join("\\n");
  return { format: "module", source: stub, shortCircuit: true };
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const React = await import("react");
assert.equal(
  typeof React.useState,
  "undefined",
  "Run this consumer with the react-server condition",
);

const root = await import("@topik/content-react");
const compiled = root.compileTopikContent("# Server\n\n- [x] Rendered");
assert.equal(compiled.ok, true);
const tree = root.renderTopikContent(compiled, {
  components: { TopikLink: ({ children }) => React.createElement("span", null, children) },
});
assert.ok(tree, "renderTopikContent returns a React tree on the server");
const markdown = root.renderTopikMarkdown("Hello [link](/x)", {
  components: { TopikLink: ({ children }) => React.createElement("span", null, children) },
});
assert.ok(markdown, "renderTopikMarkdown returns a React tree on the server");
assert.throws(() => root.renderTopikMarkdown("{% mystery /%}"), root.InvalidTopikContentError);
assert.equal(typeof root.createPreviewAssetAdapter, "function");
assert.equal(typeof root.getTopikComponents().TopikCallout, "function");
// Stateful exports cross the boundary as client references instead of failing to import.
assert.equal(root.TopikContentProvider.$$typeof, clientReference);
assert.equal(root.useTopikComponents.$$typeof, clientReference);

for (const specifier of ["@topik/content-react/theme", "@topik/content-react/rich"]) {
  const entry = await import(specifier);
  const component = specifier.endsWith("theme")
    ? entry.TopikContent
    : entry.RichTopikContentProvider;
  assert.equal(component.$$typeof, clientReference, `${specifier} is a client boundary`);
}

console.log("Verified React Server Component imports");
