import { z } from "zod";

/**
 * Reject unknown keys of a configuration record that look like misspellings of known keys,
 * such as `navigaton` or `Title`. Other unknown keys stay accepted: source writing
 * deliberately preserves unrelated configuration entries.
 */
export function rejectMisspelledKeys(
  raw: unknown,
  known: readonly string[],
  path: readonly (string | number)[] = [],
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  for (const key of Object.keys(raw)) {
    if (known.includes(key)) continue;
    if (known.some((candidate) => isLikelyMisspelling(key, candidate)))
      throw new z.ZodError([
        {
          code: "unrecognized_keys",
          keys: [key],
          path: [...path],
          message: `Unrecognized key: "${key}"`,
          input: raw as Record<string, unknown>,
        },
      ]);
  }
}

function isLikelyMisspelling(key: string, candidate: string): boolean {
  const left = key.toLowerCase();
  const right = candidate.toLowerCase();
  // Short names tolerate only case differences; longer names tolerate small edits.
  const limit = right.length < 4 ? 0 : right.length < 6 ? 1 : 2;
  return Math.abs(left.length - right.length) <= limit && editDistance(left, right) <= limit;
}

/** Optimal string alignment distance: insertions, deletions, substitutions, transpositions. */
function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, i) =>
    Array.from({ length: right.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= left.length; i++)
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1])
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  return rows[left.length][right.length];
}
