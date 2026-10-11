/**
 * Match the YAML fences used by micromark-extension-frontmatter without parsing
 * the Markdown body. Only a leading BOM, exact unindented `---` delimiters and
 * trailing spaces/tabs are accepted; the closing delimiter is required.
 */
export function frontmatterEnd(source: string): number {
  const opening = delimiterEnd(source, source.startsWith("\uFEFF") ? 1 : 0);
  // An opening delimiter must be followed by a line ending, not just EOF.
  if (opening === undefined || opening === source.length) return 0;

  let start = nextLineStart(source, opening);
  while (start < source.length) {
    const closing = delimiterEnd(source, start);
    if (closing !== undefined) return closing;

    let end = start;
    while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end++;
    start = nextLineStart(source, end);
  }
  return 0;
}

function delimiterEnd(source: string, start: number): number | undefined {
  if (!source.startsWith("---", start)) return undefined;
  let end = start + 3;
  while (source[end] === " " || source[end] === "\t") end++;
  if (end === source.length || source[end] === "\n" || source[end] === "\r") return end;
  return undefined;
}

function nextLineStart(source: string, end: number): number {
  return end + (source[end] === "\r" && source[end + 1] === "\n" ? 2 : 1);
}
