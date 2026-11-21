/** Find the same Markdown header boundary for compilation and source byte inspection. */
export function markdownFrontmatter(raw: string) {
  // CRLF, LF and lone CR end lines, as in the content parser.
  const match = raw.match(
    /^(\uFEFF?---[ \t]*(?:\r\n|\r|\n))(?:---[ \t]*(?:\r\n|\r|\n|$)|([\s\S]*?)(?:\r\n|\r|\n)---[ \t]*(?:\r\n|\r|\n|$))/,
  );
  if (!match) return undefined;
  const frontmatter = match[2] ?? "";
  const start = match[1].length;
  return {
    frontmatter,
    content: raw.slice(match[0].length),
    start,
    end: start + frontmatter.length,
    bodyStart: match[0].length,
  };
}
