import type { BlockContent, DefinitionContent, Node, Parent, PhrasingContent } from "mdast";

export type TagDeclarations = Record<string, { kind: "inline" | "block" }>;
export interface TagTextTemplate {
  type: "topikTextTemplate";
  segments: Array<{ type: "literal"; value: string } | { type: "variable"; path: string[] }>;
}
export type TagAttributeValue = string | number | boolean | TagTextTemplate;
/** Bounds on both the incoming mdast tree and the converted tag tree. */
export const TAG_LIMITS = Object.freeze({
  treeDepth: 128,
  treeNodes: 50_000,
  templateLength: 1_000_000,
});
export interface TagSyntaxOptions {
  /** Opt in to variables, conditions, text templates, and bounded code templates. */
  expressions?: boolean;
  /** Named attributes that can encode LF, CR and TAB with backslash escapes. */
  escapedWhitespace?: Readonly<Record<string, readonly string[]>>;
}
export type TagNode =
  | TagTextNode
  | TagLeafNode
  | TagContainerNode
  | TagVariableNode
  | TagConditionalNode
  | TagCodeTemplateNode;

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
export interface TagCodeTemplateNode extends Node {
  type: "tagCodeTemplate";
  lang?: string | null;
  meta?: string | null;
  template: TagTextTemplate;
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
    tagCodeTemplate: TagCodeTemplateNode;
  }
  interface RootContentMap {
    tagBranch: TagBranchNode;
    tagText: TagTextNode;
    tagLeaf: TagLeafNode;
    tagContainer: TagContainerNode;
    tagVariable: TagVariableNode;
    tagConditional: TagConditionalNode;
    tagCodeTemplate: TagCodeTemplateNode;
  }
}
export interface TagDiagnostic {
  id?: string;
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
