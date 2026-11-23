---
"@topik/codemod": patch
---

Remove the common indentation of Mintlify component bodies so indented text,
fences and lists keep their meaning instead of becoming code blocks, and refuse
ambiguous tab/space indentation. Keep each file's line endings, report Topik
validation diagnostics, and keep `.mdx` files that use MDX-only ESM or
`{expressions}`. List each file's outcome for dry and real runs, report kept
extensions once per run, never remove a source before its replacement is
published, and point out staging directories left by an interrupted run.
