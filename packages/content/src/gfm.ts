import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown, gfmTableToMarkdown } from "mdast-util-gfm-table";
import stringWidth from "string-width";
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from "mdast-util-gfm-task-list-item";
import type { Handle, Options } from "mdast-util-to-markdown";
import type { Association } from "mdast";
import { referenceSourceLabel } from "./document-index.js";

/**
 * Footnote labels keep their authored spelling, as other reference labels do (see
 * `reference-writer.ts`). The stock writer prints the decoded label, so `[^a\+b]` became
 * `[^a+b]`, a different footnote; escaping that label again would double its backslashes.
 * Validation admits only labels that can be written this way.
 */
function footnoteToMarkdown(): Options {
  const footnoteReference: Handle = (node, _parent, state, info) => {
    const tracker = state.createTracker(info);
    let value = tracker.move("[^");
    const exit = state.enter("footnoteReference");
    value += tracker.move(referenceSourceLabel(node as unknown as Association));
    exit();
    return value + tracker.move("]");
  };
  const footnoteDefinition: Handle = (node, _parent, state, info) => {
    const definition = node as unknown as Association & { children?: unknown[] };
    const tracker = state.createTracker(info);
    let value = tracker.move("[^");
    const exit = state.enter("footnoteDefinition");
    value += tracker.move(referenceSourceLabel(definition));
    value += tracker.move("]:");
    if (definition.children && definition.children.length > 0) {
      tracker.shift(4);
      value += tracker.move(
        " " +
          state.indentLines(
            state.containerFlow(node as never, tracker.current()),
            (line, index, blank) => (index === 0 ? line : (blank ? "" : "    ") + line),
          ),
      );
    }
    exit();
    return value;
  };
  return {
    ...gfmFootnoteToMarkdown(),
    handlers: { footnoteReference, footnoteDefinition },
  };
}

// Compose the supported GFM features explicitly. The umbrella also installs an
// autolink tokenizer AND an mdast text transform; Topik omits both so bare URLs
// and email addresses stay text. CommonMark's explicit <...> links remain enabled.
export function gfmSyntax() {
  return [gfmFootnote(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()];
}

export function gfmFromMarkdown() {
  return [
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ];
}

export function gfmToMarkdown() {
  return {
    extensions: [
      footnoteToMarkdown(),
      gfmStrikethroughToMarkdown(),
      // Pad table columns by display width, so cells with emoji or CJK text line
      // up in editors and agree with Prettier.
      gfmTableToMarkdown({ stringLength: stringWidth }),
      gfmTaskListItemToMarkdown(),
    ],
  };
}
