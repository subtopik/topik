---
"@topik/content": patch
"@topik/remark-tags": patch
---

Close a parser-budget bypass: label ends without an open label, escaped
brackets, undefined references and unclosed resources now charge the footnote
lookup and text-merging work they cause, so such paragraphs parse in bounded
time or report `topik-content-limit`. Tag names such as `constructor` no longer
crash attribute parsing and report `tag-undefined`. An opening tag with invalid
attributes keeps its scope, so its closer no longer also reports
`missing-opening`. Content diagnostics keep the source `column` when one is
known. Blank lines after the last item of a list inside a block quote no longer
make the list loose, and a blank line between an item's blocks there makes the
item loose, as in CommonMark. Formatting now writes shortcut references before
links, vertical tabs at text boundaries, leading whitespace in code-fence
metadata, lists that cannot interrupt a paragraph inside quotes, and rules at
the start of an alternate-bullet list item without changing their meaning.
