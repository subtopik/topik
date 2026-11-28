---
"@topik/codemod": patch
---

Match Mintlify JSX tag names with a sticky regular expression and require a valid tag-name delimiter (`whitespace`, `>`, `/`, or end of input) so tags such as `<Note.Sub>`, `<Card-custom>`, and `<Info_2>` are not misparsed as Mintlify components.
