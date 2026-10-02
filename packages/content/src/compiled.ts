import type { RenderableTreeNode } from "./render.js";
import type { TopikContentDiagnostic } from "./diagnostics.js";

export interface CompiledTopikContent {
  sourceFormat: "topik";
  topikSchemaVersion: string;
  formatVersion: number;
  configHash: string;
  renderableTree: RenderableTreeNode;
  diagnostics: TopikContentDiagnostic[];
}
