---
"@topik/content": patch
"@topik/core": patch
---

Diagnostics name files the way they are written. A relative path with spaces,
non-ASCII letters or characters such as `#`, `?`, `@` and `%`, like
`guides/getting started.md` or `wiki/Übersicht.md`, is no longer replaced by the
generic `content` label, in the CLI, in compile errors and in the preview. Paths
that could disguise or leak something are still refused: absolute paths keep only
their file name, and a path with a `:`, a percent-escape such as `%2F`, a control,
invisible or bidirectional character, whitespace other than a space, or an empty,
`.`, `..` or space-padded segment gets the generic label.
