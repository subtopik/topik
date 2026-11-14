---
"@topik/content": patch
"@topik/codemod": patch
---

Admit long ordinary documents under the inline parser budget. The budget now charges only syntax whose resolution can grow superlinearly within a paragraph (possible closing emphasis delimiters, unmatched code-span scans and label rereads) instead of every `!`, `*`, `[`, `_`, `~` and backtick, and also refuses padded delimiter and code-span inputs that previously took tens of seconds. `CONTENT_LIMITS` is documented in the `@topik/content` README.
