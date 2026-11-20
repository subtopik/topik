---
"@topik/content": patch
"@topik/content-react": patch
---

Support Markdown footnotes. A reference `[^label]` links to the definition `[^label]: …` with the same label, ignoring letter case, and a definition can hold several paragraphs, lists and code.

- Definitions can be written anywhere at the top level of a document. Formatting, `writeDocument` and editor saves write every definition at the end, in order of first reference, and keep authored labels; the position is spelling, not meaning. Targeted rewrites, such as asset and link repairs, keep definitions where they are so tree positions stay stable.
- Labels are one word and unique across the document, including conditional branches. A definition inside a quote, list, component or branch, a repeated label, a definition nothing references and a reference inside a footnote, a link or a quiz explanation (which appears only after the reader answers) are refused with `topik-footnote-placement`, `topik-footnote-duplicate`, `topik-footnote-unreferenced` and `topik-footnote-nested`. A footnote cannot contain headings, link definitions or conditionals (`topik-footnote-content`), and explicit heading IDs cannot start with the footnote anchor prefixes `fn:` or `fnref:` (`topik-heading-id-reserved`). A tree built in code that references a missing definition reports `topik-footnote-missing`.
- Evaluation leaves out a footnote whose references are all in hidden branches without evaluating its body, and a footnote whose body evaluates to nothing together with its references. The reader tree numbers footnotes by their first shown reference, ignoring references inside components that do not render, and lists them after the content as `TopikFootnotes` and `TopikFootnote`, with `TopikFootnoteReference` superscripts, `fn:N` and `fnref:N` anchors and back-links.
- The theme styles the references, the list and the back-links, and print leaves out the back-links. Without themed components, footnotes render as superscript links and an ordered list.

Breaking: `TopikComponentName` and `TopikComponentMap` gain `TopikFootnoteReference`, `TopikFootnotes` and `TopikFootnote`, and the internal `serializeDocument` option `preserveMarkNesting` is renamed `preserveTreePositions`.
