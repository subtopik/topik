import { defaultHandlers, type State, type Info } from "mdast-util-to-markdown";
import { decodeString } from "micromark-util-decode-string";

/** Index of each child, built once per container instead of searched per text. */
const indexes = new WeakMap<object, Map<unknown, number>>();
function position(
  node: unknown,
  parent: unknown,
): { index: number; count: number; children: readonly unknown[] } {
  const children = (parent as { children?: unknown[] } | undefined)?.children;
  if (!children) return { index: -1, count: 0, children: [] };
  let map = indexes.get(children);
  if (!map) {
    map = new Map(children.map((child, index) => [child, index]));
    indexes.set(children, map);
  }
  return { index: map.get(node) ?? -1, count: children.length, children };
}

/**
 * Whether a footnote reference directly before this text starts a line, where `[^1]: text` reads
 * as a definition: the first child of a paragraph or heading, or the first node after a hard
 * break or a line ending, in any inline container.
 */
function followsLineStartFootnote(node: unknown, parent: { type: string } | undefined): boolean {
  const { index, children } = position(node, parent);
  if (index < 1 || (children[index - 1] as { type?: string }).type !== "footnoteReference")
    return false;
  // A heading with a line ending is written in setext form, where its first line starts with it.
  if (index === 1) return parent?.type === "paragraph" || parent?.type === "heading";
  const before = children[index - 2] as { type?: string; value?: unknown };
  return (
    before.type === "break" ||
    (before.type === "text" && typeof before.value === "string" && /\n[ \t]*$/u.test(before.value))
  );
}

export function boundaryWhitespaceWriterExtension() {
  return {
    handlers: {
      text(
        node: { value: string },
        parent: { type: string } | undefined,
        state: State,
        info: Info,
      ): string {
        const written = writeText(node, parent, state, info);
        // `\:` keeps the colon text; nothing else changes the line.
        return written.startsWith(":") && followsLineStartFootnote(node, parent)
          ? `\\${written}`
          : written;
      },
    },
  } as const;
}

function writeText(
  node: { value: string },
  parent: { type: string } | undefined,
  state: State,
  info: Info,
): string {
  if (parent?.type !== "delete" && parent?.type !== "tableCell" && !node.value.includes("\n"))
    return defaultHandlers.text(node as never, parent as never, state, info);
  const characters = Array.from(node.value);
  let first = 0;
  let last = characters.length;
  while (first < last && /^\s$/u.test(characters[first])) first++;
  while (last > first && /^\s$/u.test(characters[last - 1])) last--;
  // Markdown trims whitespace only at the edges of a paragraph, cell or
  // strikethrough. Next to inline siblings such as code, plain spaces and a
  // single line ending survive as written and need no references.
  const { index, count, children } = position(node, parent);
  const literal = (run: string) => /^[ \t]*$/u.test(run) || run === "\n";
  // A hard break ends its line, so whitespace after it keeps its reference, as before.
  const hasBefore = index > 0 && (children[index - 1] as { type?: string }).type !== "break";
  const hasAfter = index !== -1 && index < count - 1;
  if (first === characters.length) {
    // Text that is all whitespace touches both sides, so it needs a sibling on each.
    if (hasBefore && hasAfter && literal(node.value)) first = 0;
  } else {
    if (hasBefore && literal(characters.slice(0, first).join(""))) first = 0;
    if (hasAfter && literal(characters.slice(last).join(""))) last = characters.length;
  }
  const blankLines = /\n[ \t]*\n/.test(node.value);
  if (first === 0 && last === characters.length && !blankLines)
    return defaultHandlers.text(node as never, parent as never, state, info);
  // CommonMark decodes a reference to a control character such as U+000B
  // as U+FFFD. Markdown never trims those characters, so they stay literal.
  const entity = (character: string) => {
    const reference = `&#x${character.codePointAt(0)!.toString(16)};`;
    return decodeString(reference) === character ? reference : character;
  };
  const before = characters.slice(0, first).map(entity).join("");
  const after = characters.slice(last).map(entity).join("");
  const middleInfo = {
    ...info,
    before: before ? before.at(-1)! : info.before,
    after: after ? after[0] : info.after,
  };
  const value = characters.slice(first, last).join("");
  // Text can contain literal line feeds decoded from character references.
  // Writing these as blank source lines would split a paragraph or table.
  const parts = blankLines ? value.split("\n") : [value];
  const middle = parts
    .map((part, index) =>
      state.safe(part, {
        ...middleInfo,
        before: index === 0 ? middleInfo.before : ";",
        after: index === parts.length - 1 ? middleInfo.after : "&",
      }),
    )
    .join("&#xa;");
  return before + middle + after;
}
