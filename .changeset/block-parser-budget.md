---
"@topik/content": patch
"@topik/codemod": patch
---

Bound the parser work of closing block quotes and lists. The Markdown parser rebuilds its event list for the whole document each time a lazy line or blank line ends a block quote or list, or a list item closes a quote or list nested in the previous item, and it walks back over the open paragraph for every lazy continuation line. Documents with thousands of such closings took tens of seconds to minutes; the `parserSteps` budget now charges this work, so they are refused with `topik-content-limit` within about two seconds. Ordinary documents, long tight lists and quoted text are unaffected.
