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
  // Like bundler proxies, a client reference is opaque: dotting into it fails on the server.
  const reference = (id) =>
    "new Proxy(function () { throw new Error('Client reference called on the server'); }, { get(target, key) {" +
    " if (key === '$$typeof') return Symbol.for('react.client.reference');" +
    " if (key === '$$id') return " + JSON.stringify(id) + ";" +
    " if (typeof key === 'symbol' || ['name', 'displayName', 'defaultProps', 'toJSON', 'then', '$$async'].includes(key)) return undefined;" +
    " throw new Error('Cannot access ' + key + ' on a client reference from the server'); } })";
  const stub = names
    .map((name) => "export const " + (name === "default" ? "__default" : name) + " = " +
      reference(url + "#" + name) + ";" + (name === "default" ? " export default __default;" : ""))
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

// Server components assemble their map from individually imported themed components:
// each is a client reference React can render, while the theme's map object is opaque.
const theme = await import("@topik/content-react/theme");
assert.throws(
  () => root.renderTopikMarkdown("# Map", { components: theme.defaultTopikComponents }),
  /client reference/,
);
const serverTree = root.renderTopikMarkdown("{% callout %}\nServer\n{% /callout %}", {
  components: { TopikCallout: theme.TopikCallout },
});
assert.equal(serverTree.props.children.type, theme.TopikCallout);

for (const specifier of ["@topik/content-react/theme", "@topik/content-react/rich"]) {
  const entry = await import(specifier);
  const component = specifier.endsWith("theme")
    ? entry.TopikContent
    : entry.RichTopikContentProvider;
  assert.equal(component.$$typeof, clientReference, `${specifier} is a client boundary`);
}

console.log("Verified React Server Component imports");
