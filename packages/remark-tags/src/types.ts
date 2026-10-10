import type { BlockContent, DefinitionContent, Node, Parent, PhrasingContent } from "mdast";

export type TagDeclarations = Record<string, { kind: "inline" | "block" }>;
export type TagAttributeValue = string | number | boolean;
/** Bounds on both the incoming mdast tree and the converted tag tree. */
export const TAG_LIMITS = Object.freeze({ treeDepth: 128, treeNodes: 50_000 });
export interface TagSyntaxOptions {
  /** Opt in to variable and conditional syntax; literal component tags remain unchanged. */
  expressions?: boolean;
  /** Named attributes that can encode LF, CR and TAB with backslash escapes. */
  escapedWhitespace?: Readonly<Record<string, readonly string[]>>;
}
export type TagNode =
  | TagTextNode
  | TagLeafNode
  | TagContainerNode
  | TagVariableNode
  | TagConditionalNode;

interface NamedTag extends Parent {
  name: string;
  attributes?: Record<string, TagAttributeValue | null | undefined>;
}

export interface TagTextNode extends NamedTag {
  type: "tagText";
  children: PhrasingContent[];
}

export interface TagLeafNode extends NamedTag {
  type: "tagLeaf";
  children: [];
}

export interface TagContainerNode extends NamedTag {
  type: "tagContainer";
  children: Array<BlockContent | DefinitionContent>;
}

export interface TagVariableNode extends Node {
  type: "tagVariable";
  path: string;
}
export interface TagBranchNode extends Parent {
  type: "tagBranch";
  condition: string | null;
  children: Array<BlockContent | DefinitionContent>;
}
export interface TagConditionalNode extends Parent {
  type: "tagConditional";
  children: TagBranchNode[];
}

declare module "mdast" {
  interface PhrasingContentMap {
    tagText: TagTextNode;
    tagVariable: TagVariableNode;
  }
  interface BlockContentMap {
    tagLeaf: TagLeafNode;
    tagContainer: TagContainerNode;
    tagConditional: TagConditionalNode;
  }
  interface RootContentMap {
    tagBranch: TagBranchNode;
    tagText: TagTextNode;
    tagLeaf: TagLeafNode;
    tagContainer: TagContainerNode;
    tagVariable: TagVariableNode;
    tagConditional: TagConditionalNode;
  }
}
export interface TagDiagnostic {
  id?: "tag-content-limit";
  message: string;
  line?: number;
  column?: number;
}

export class TagSyntaxError extends Error {
  constructor(readonly diagnostics: TagDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join("; "));
    this.name = "TagSyntaxError";
  }
}
