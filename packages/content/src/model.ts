import type { Node, Root, RootContent } from "mdast";
import type { Expression } from "./expressions.js";

export type Scalar = string | number | boolean;

export interface Variable extends Node {
  type: "topikVariable";
  path: string[];
}

export interface Branch extends Node {
  type: "topikBranch";
  condition: Expression | null;
  children: Array<RootContent | Component | Conditional>;
}

export interface Conditional extends Node {
  type: "topikConditional";
  children: Branch[];
}

export interface Component extends Node {
  type: "topikComponent";
  name: string;
  props: Record<string, Scalar>;
  children: Array<RootContent | Component>;
}

declare module "mdast" {
  interface BlockContentMap {
    topikComponent: Component;
    topikConditional: Conditional;
  }
  interface PhrasingContentMap {
    topikComponent: Component;
    topikVariable: Variable;
  }
  interface RootContentMap {
    topikComponent: Component;
    topikConditional: Conditional;
    topikVariable: Variable;
  }
}

export interface ContentDocument extends Omit<Root, "children"> {
  children: Array<RootContent | Component>;
}

export interface Diagnostic {
  /** Stable machine-readable code for public compatibility adapters. */
  id?: string;
  type?: string;
  message: string;
  line?: number;
  column?: number;
}

export type ParseResult =
  | { ok: true; document: ContentDocument; source: string }
  | { ok: false; diagnostics: Diagnostic[]; source: string };

export type TreeNode = {
  type: string;
  children?: TreeNode[];
  value?: string;
  position?: {
    start: { line: number; column: number; offset?: number };
    end: { line: number; column: number; offset?: number };
  };
  name?: string;
  attributes?: Record<string, Scalar | null | undefined>;
  path?: string | string[];
  condition?: string | Expression | null;
  props?: Record<string, Scalar>;
};
