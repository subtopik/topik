import type { Definition } from "mdast";
import type { Component, ContentDocument } from "./model.js";
import { components, type Registry } from "./registry.js";
import { validateDocument } from "./validation.js";
import { indexDocument, isReference } from "./document-index.js";

/** Rewrite asset definitions once, preserving reference identity and unrelated navigation. */
export function rewriteAssets(
  document: ContentDocument,
  replace: (url: string) => string | undefined,
  registry: Registry = components,
): ContentDocument {
  const inputErrors = validateDocument(document, registry);
  if (inputErrors.length) throw new Error(inputErrors.map((error) => error.message).join("; "));
  const cloned = structuredClone(document);
  const index = indexDocument(cloned);
  const images = new Set<Definition>();
  const links = new Set<Definition>();
  for (const { node } of index.entries) {
    if (!isReference(node)) continue;
    const definition = index.resolve(node);
    if (definition) (node.type === "imageReference" ? images : links).add(definition);
  }
  for (const { node } of index.entries) {
    if (node.type === "image") {
      const image = node as unknown as { url: string };
      image.url = replace(image.url) ?? image.url;
    } else if (node.type === "definition" && images.has(node as Definition)) {
      const definition = node as Definition;
      const next = replace(definition.url);
      if (next !== undefined && next !== definition.url && links.has(definition))
        throw new Error(
          `Cannot rewrite definition ${definition.identifier}: it is shared by an image and a link`,
        );
      definition.url = next ?? definition.url;
    } else if (node.type === "topikComponent") {
      const component = node as Component;
      for (const [key, attribute] of Object.entries(registry[component.name].attributes)) {
        const value = component.props[key];
        if ((attribute.asset || attribute.assetReference) && typeof value === "string")
          component.props[key] = replace(value) ?? value;
      }
    }
  }
  const errors = validateDocument(cloned, registry);
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  return cloned;
}
