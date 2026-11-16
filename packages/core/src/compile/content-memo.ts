import {
  analyzeTopikContent,
  validateTopikContent,
  type AnalyzeTopikContentResult,
  type ValidateTopikContentResult,
} from "@topik/content";

/**
 * @internal Source admission and analysis remembered for one compiler call. Results are keyed
 * by the exact source text and diagnostic file label, the only inputs the compiler passes, so a
 * repeated call returns what a fresh call would. Create one per call; never keep it across calls.
 */
export interface ContentMemo {
  validate(source: string, file: string): ValidateTopikContentResult;
  analyze(source: string, file: string): AnalyzeTopikContentResult;
}

export function createContentMemo(): ContentMemo {
  const validations = new Map<string, Map<string, ValidateTopikContentResult>>();
  const analyses = new Map<string, Map<string, AnalyzeTopikContentResult>>();
  function remember<T>(
    store: Map<string, Map<string, T>>,
    source: string,
    file: string,
    compute: () => T,
  ): T {
    let byFile = store.get(source);
    if (byFile === undefined) store.set(source, (byFile = new Map()));
    let result = byFile.get(file);
    if (result === undefined) byFile.set(file, (result = compute()));
    return result;
  }
  return {
    validate: (source, file) =>
      remember(validations, source, file, () => validateTopikContent(source, { file })),
    analyze: (source, file) =>
      remember(analyses, source, file, () => analyzeTopikContent(source, { file })),
  };
}
