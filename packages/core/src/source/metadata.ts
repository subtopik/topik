import { serializeTopikJson } from "../assets/json";

/** Existing mapping leaves change individually so sibling metadata keeps its original syntax. */
export function collectMetadataEdits(
  updates: Record<string, unknown>,
  selector: string,
  previous: unknown,
  desired: unknown,
): void {
  if (
    serializeTopikJson(previous ?? null) === serializeTopikJson(desired ?? null) &&
    (previous === undefined) === (desired === undefined)
  )
    return;
  if (
    previous &&
    desired &&
    typeof previous === "object" &&
    typeof desired === "object" &&
    !Array.isArray(previous) &&
    !Array.isArray(desired)
  ) {
    const before = previous as Record<string, unknown>;
    const after = desired as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      collectMetadataEdits(
        updates,
        `${selector}/${encodeURIComponent(key)}`,
        before[key],
        after[key],
      );
  } else updates[selector] = desired;
}
