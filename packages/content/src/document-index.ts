import type { Association, Definition, ImageReference, LinkReference } from "mdast";
import type { ContentDocument, TreeNode } from "./model.js";
import { assertDataLimits, assertTreeLimits } from "./limits.js";

interface ReferenceScope {
  parent?: ReferenceScope;
  definitions: Map<string, Definition>;
}

export interface DocumentEntry {
  node: TreeNode;
  path: readonly number[];
  parent?: TreeNode;
  scope: ReferenceScope;
}

export interface DocumentIndex {
  entries: readonly DocumentEntry[];
  /** Definitions are document-wide inside a scope; conditional branches introduce scopes. */
  resolve(reference: ImageReference | LinkReference): Definition | undefined;
}

export function referenceIdentifier(identifier: string): string {
  return identifier
    .replace(/[\t\n\r ]+/gu, " ")
    .replace(/^ | $/gu, "")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

/** Keep source escapes intact: decoded labels can identify a different definition. */
export function referenceSourceLabel(node: Association): string {
  const value =
    node.label && referenceIdentifier(node.label) === referenceIdentifier(node.identifier)
      ? node.label
      : node.identifier;
  return value.replace(/[\t\n\r ]+/gu, " ").replace(/^ | $/gu, "");
}

/** One bounded traversal shared by validation, asset processing, and source analysis. */
export function indexDocument(document: ContentDocument): DocumentIndex {
  assertDataLimits(document, { plain: true });
  assertTreeLimits(document as TreeNode);
  const entries: DocumentEntry[] = [];
  const scopes = new Map<TreeNode, ReferenceScope>();
  const rootScope: ReferenceScope = { definitions: new Map() };
  function visit(
    node: TreeNode,
    path: readonly number[],
    scope: ReferenceScope,
    parent?: TreeNode,
  ): void {
    if (node.type === "topikBranch") scope = { parent: scope, definitions: new Map() };
    entries.push({ node, path, scope, parent });
    scopes.set(node, scope);
    if (node.type === "definition") {
      const definition = node as Definition;
      const key = referenceIdentifier(definition.identifier);
      if (!scope.definitions.has(key)) scope.definitions.set(key, definition);
    }
    for (const [index, child] of (node.children ?? []).entries())
      visit(child, [...path, index], scope, node);
  }
  visit(document as TreeNode, [], rootScope);
  return {
    entries,
    resolve(reference) {
      const key = referenceIdentifier(reference.identifier);
      for (let scope = scopes.get(reference as TreeNode); scope; scope = scope.parent) {
        const definition = scope.definitions.get(key);
        if (definition) return definition;
      }
    },
  };
}

export function isReference(node: TreeNode): node is ImageReference | LinkReference {
  return node.type === "imageReference" || node.type === "linkReference";
}

/** Bind before pruning branches so evaluation cannot change an authored destination. */
export function materializeReferences(
  document: ContentDocument,
  index: DocumentIndex = indexDocument(document),
): void {
  for (const { node } of index.entries) {
    if (!isReference(node)) continue;
    const definition = index.resolve(node);
    if (!definition) throw new Error(`Reference ${node.identifier} has no definition in its scope`);
    const resource = node as unknown as Record<string, unknown>;
    resource.type = node.type === "imageReference" ? "image" : "link";
    resource.url = definition.url;
    resource.title = definition.title ?? null;
    delete resource.identifier;
    delete resource.label;
    delete resource.referenceType;
  }
}
