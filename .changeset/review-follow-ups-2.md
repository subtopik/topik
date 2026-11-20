---
"@topik/content": patch
"@topik/core": patch
"@topik/codemod": patch
---

Follow-ups from review:

- Diagnostic labels refuse characters that display as nothing, such as U+034F, like other invisible characters, and a label taken from a URL is refused when its path is percent-encoded, as `lesson%20one.md` is.
- Compile locations refuse HTML character references such as `&#47;`, matching content diagnostic labels.
- Preview diagnostics publish a backslash path with `/` separators and find its resource by that path.
- `{% kbd %} {% /kbd %}`, a key of only whitespace, is refused with `topik-kbd-children`, like an empty key.
- `topik-count-range` no longer names `columns` in its message, since a custom component's `count` can report it too.
- The Mintlify codemod wraps content between the cards of `<Columns>` or `<CardGroup>` in a `column` instead of keeping the page unconverted, and notes that Mintlify gives each element its own cell.
