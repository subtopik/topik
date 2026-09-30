import type { TopikContentConfig } from "./config.js";
import { sanitizeTopikContentDiagnostic, type TopikContentDiagnostic } from "./diagnostics.js";
import { transformDocument, type RenderableTreeNode } from "./render.js";
import { prepareSource } from "./source.js";

export interface CompileTopikContentOptions {
  file?: string;
  config?: TopikContentConfig;
  onDiagnostic?: (diagnostic: TopikContentDiagnostic) => void;
}

export interface CompileTopikContentSuccess {
  ok: true;
  /** Exact caller-supplied source. */
  source: string;
  diagnostics: TopikContentDiagnostic[];
  tree: RenderableTreeNode;
}

export interface CompileTopikContentFailure {
  ok: false;
  /** Exact caller-supplied source, unchanged and never transformed. */
  source: string;
  diagnostics: TopikContentDiagnostic[];
}

export type CompileTopikContentResult = CompileTopikContentSuccess | CompileTopikContentFailure;

/** Admit source once, including compiled asset references, and produce a reader tree. */
export function compileTopikContent(
  source: string,
  options: CompileTopikContentOptions = {},
): CompileTopikContentResult {
  const prepared = prepareSource(source, {
    file: options.file,
    config: options.config,
    allowCompiledAssetReferences: true,
  });
  if (!prepared.ok) {
    for (const diagnostic of prepared.diagnostics) options.onDiagnostic?.(diagnostic);
    return prepared;
  }

  try {
    return {
      ok: true,
      source,
      diagnostics: [],
      tree: transformDocument(prepared.document, prepared.config),
    };
  } catch {
    const diagnostic = sanitizeTopikContentDiagnostic({
      id: "topik-transform-failed",
      type: "document",
      level: "critical",
      message: "",
      lines: [],
      ...(options.file === undefined ? {} : { file: options.file }),
    });
    options.onDiagnostic?.(diagnostic);
    return { ok: false, source, diagnostics: [diagnostic] };
  }
}
