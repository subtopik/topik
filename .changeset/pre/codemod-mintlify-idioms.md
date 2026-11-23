---
"@topik/codemod": patch
---

Keep Mintlify components in tables, headings and paragraph text, and
mismatched closing tags, unchanged with a warning instead of splitting the
surrounding content. Convert idiomatic `<CodeGroup>` fences to titled code tabs,
`<CardGroup cols={2}>`, literal `{number}`/`{true}`/`{false}` attributes and
`defaultOpen`, and drop `icon` on steps, tabs and accordions with a warning.
Dedent bodies under multi-line opening tags, keep CR-only line endings and a BOM
directly before a tag, match `.MDX`/`.MD` extensions case-insensitively, report
skipped symbolic links, and print the version for `--version`.
