---
"@topik/core": patch
---

Tighten media sniffing so prose and code stay downloads: event handlers and
`javascript:` URLs count only inside a real start tag, SVG only when it opens the
text or appears as a closed element, and an XML document with a non-HTML root (such
as a property list) is data. `MZ` needs a PE header and `#!` an interpreter path
before a file counts as executable, and markup inspection is now linear in the
inspected text. topik-json-v1 rejects a high surrogate at the end of a string.
Schema-invalid Guide and WikiPage titles and descriptions fail as
`frontmatter-invalid` at the source file with the field name, unversioned Wiki
page descriptions are shortened without splitting a surrogate pair, missing and
ambiguous Wiki page files report the page path, repeated spellings of one path
collision report it once, and project namespaces with surrounding whitespace are
refused.
