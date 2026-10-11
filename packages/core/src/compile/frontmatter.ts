/** Find the same Markdown header boundary for compilation and source byte inspection. */
export function markdownFrontmatter(raw: string) {
  const match = raw.match(/^\uFEFF?---\r?\n(?:---(?:\r?\n|$)|([\s\S]*?)\r?\n---(?:\r?\n|$))/);
  if (!match) return undefined;
  const frontmatter = match[1] ?? "";
  const start = raw.indexOf("\n") + 1;
  return {
    frontmatter,
    content: raw.slice(match[0].length),
    start,
    end: start + frontmatter.length,
    bodyStart: match[0].length,
  };
}
