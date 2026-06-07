import type { RenderableTreeNode } from "@markdoc/markdoc";
import type { TopikContentDiagnostic } from "./diagnostics";

export interface CompiledTopikContent {
  sourceFormat: "topik";
  topikSchemaVersion: string;
  markdocVersion: string;
  configHash: string;
  renderableTree: RenderableTreeNode;
  assets: string[];
  diagnostics: TopikContentDiagnostic[];
}
