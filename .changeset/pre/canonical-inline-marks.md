---
"@topik/content": patch
---

Write inline marks in one canonical nesting and compare them as a set. `formatTopikContent`, `formatDocument` and `writeDocument` now produce the same output for equivalent spellings such as `**[a](u)**` and `[**a**](u)`, `***a***`, `**_a_**` and `_**a**_`, or `~~**a**~~` and `**~~a~~**`, and merge adjacent identical marks (`**a**__b__` becomes `**ab**`). `sameDocumentMeaning` treats these spellings as equal, while still distinguishing differently marked spaces, separate links and changed text. Parsing and asset or navigation rewrites keep the authored nesting.
