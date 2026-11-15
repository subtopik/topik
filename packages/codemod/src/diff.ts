/** Edit scripts longer than this fall back to replacing the changed region outright. */
const MAX_EDIT_DISTANCE = 4000;
const CONTEXT_LINES = 3;

type Operation = { kind: " " | "-" | "+"; line: string };

/**
 * Render a unified diff between two texts. Lines keep their own terminators, so
 * line-ending changes are differences. `oldName` is `null` for a new file. Returns
 * just the file headers for a rename without content changes, and `""` when nothing changes.
 */
export function unifiedDiff(
  oldName: string | null,
  newName: string,
  oldText: string,
  newText: string,
): string {
  if (oldName === newName && oldText === newText) return "";
  const header = [`--- ${oldName === null ? "/dev/null" : `a/${oldName}`}`, `+++ b/${newName}`];
  if (oldText === newText) return `${header.join("\n")}\n`;
  const operations = diffLines(splitLines(oldText), splitLines(newText));
  return `${[...header, ...hunks(operations)].join("\n")}\n`;
}

function splitLines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function diffLines(a: readonly string[], b: readonly string[]): Operation[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle =
    myers(a.slice(start, endA), b.slice(start, endB)) ??
    replaceAll(a.slice(start, endA), b.slice(start, endB));
  return [
    ...a.slice(0, start).map((line) => ({ kind: " " as const, line })),
    ...middle,
    ...a.slice(endA).map((line) => ({ kind: " " as const, line })),
  ];
}

function replaceAll(a: readonly string[], b: readonly string[]): Operation[] {
  return [
    ...a.map((line) => ({ kind: "-" as const, line })),
    ...b.map((line) => ({ kind: "+" as const, line })),
  ];
}

/** Myers' O(ND) shortest edit script, or `undefined` when it exceeds the edit limit. */
function myers(a: readonly string[], b: readonly string[]): Operation[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds V[k] for k in [-d, d] after step d.
  const trace: Int32Array[] = [];
  let distance = -1;
  for (let d = 0; d <= max && distance < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        distance = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (distance < 0) return;

  const reversed: Operation[] = [];
  let x = n;
  let y = m;
  for (let d = distance; d > 0; d--) {
    const previous = trace[d - 1];
    const at = (k: number) => previous[k + d - 1];
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      reversed.push({ kind: " ", line: a[--x] });
      y--;
    }
    if (x === previousX) reversed.push({ kind: "+", line: b[previousY] });
    else reversed.push({ kind: "-", line: a[previousX] });
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    reversed.push({ kind: " ", line: a[--x] });
    y--;
  }
  return reversed.reverse();
}

function hunks(operations: readonly Operation[]): string[] {
  const positions: Array<{ oldLine: number; newLine: number }> = [];
  const changes: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  operations.forEach((operation, index) => {
    positions.push({ oldLine, newLine });
    if (operation.kind !== "+") oldLine++;
    if (operation.kind !== "-") newLine++;
    if (operation.kind !== " ") changes.push(index);
  });
  const lines: string[] = [];
  for (let first = 0; first < changes.length;) {
    // A hunk joins changes separated by at most twice the context.
    let last = first;
    while (last + 1 < changes.length && changes[last + 1] - changes[last] - 1 <= 2 * CONTEXT_LINES)
      last++;
    const start = Math.max(0, changes[first] - CONTEXT_LINES);
    const end = Math.min(operations.length, changes[last] + CONTEXT_LINES + 1);
    const slice = operations.slice(start, end);
    const oldCount = slice.filter((operation) => operation.kind !== "+").length;
    const newCount = slice.filter((operation) => operation.kind !== "-").length;
    // An empty side names the line before the hunk, as GNU diff does.
    const oldStart = positions[start].oldLine + (oldCount ? 1 : 0);
    const newStart = positions[start].newLine + (newCount ? 1 : 0);
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const operation of slice) {
      const body = operation.line.replace(/(?:\r\n|\r|\n)$/, "");
      lines.push(`${operation.kind}${body}`);
      if (body === operation.line) lines.push("\\ No newline at end of file");
    }
    first = last + 1;
  }
  return lines;
}
