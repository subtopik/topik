export interface CompiledTopikContent {
  sourceFormat: "topik";
  topikSchemaVersion: string;
  markdocVersion: string;
  configHash: string;
  renderableTree: unknown;
  assets: string[];
  diagnostics: unknown[];
}
