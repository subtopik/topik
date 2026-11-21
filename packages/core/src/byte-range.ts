/** A satisfiable single byte range, inclusive at both ends. */
export interface TopikByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single `bytes` range (RFC 9110) for a payload of `size` bytes. Browsers request media
 * in ranges to start playback early and to seek; Safari plays MP4 only from a server that
 * answers them. Absent, malformed and multiple ranges return `undefined`: send the whole payload
 * with 200. `"unsatisfiable"` calls for 416 with `Content-Range: bytes *\/size`.
 *
 * Self-contained on purpose: hosts that cannot import core at runtime embed its source.
 */
export function parseTopikByteRange(
  header: string | undefined,
  size: number,
): TopikByteRange | "unsatisfiable" | undefined {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/iu.exec(header.trim());
  if (match === null) return undefined;
  const first = match[1];
  const last = match[2];
  if (first === "" && last === "") return undefined;
  if (first === "") {
    // A suffix range: the final bytes of the payload.
    const length = Number(last);
    if (!Number.isSafeInteger(length)) return undefined;
    return length === 0 || size === 0
      ? "unsatisfiable"
      : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? Number.MAX_SAFE_INTEGER : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  return start >= size ? "unsatisfiable" : { start, end: Math.min(end, size - 1) };
}
