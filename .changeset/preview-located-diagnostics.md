---
"@topik/core": patch
"@topik/cli": patch
---

Preview states carry located diagnostics. Each diagnostic has a `severity`, a
`location` with the root-relative `path` and, when known, `line` and `column`,
and the `resource` whose source it is in. An `error` state lists every error
of the failed compilation, and a `ready` state lists the warnings of the
successful one, errors first and at most 100 (`PREVIEW_DIAGNOSTIC_LIMIT`), with
the rest counted in `omittedDiagnostics`. Missing Person or page references and
other compile failures carry their file, and Asset failures their stable
`TOPIK_ASSET_*` ID.

`topik dev` prints the warnings of a successful compilation, and every CLI
diagnostic with a known column reads `path:line:column severity id: message`.
A compile failure names the file and field it is about.
