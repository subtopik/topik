import { defaultHandlers, type State, type Info } from "mdast-util-to-markdown";
import { decodeString } from "micromark-util-decode-string";

export function boundaryWhitespaceWriterExtension() {
  return {
    handlers: {
      text(
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
        const siblings = (parent as { children?: unknown[] } | undefined)?.children ?? [];
        const index = siblings.indexOf(node);
        const literal = (run: string) => /^[ \t]*$/u.test(run) || run === "\n";
        if (index > 0 && literal(characters.slice(0, first).join(""))) first = 0;
        if (index !== -1 && index < siblings.length - 1 && literal(characters.slice(last).join("")))
          last = characters.length;
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
      },
    },
  } as const;
}
