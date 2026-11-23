---
"@topik/content-react": patch
---

Add a light `@topik/content-react/preview-assets` entry that exports
`createPreviewAssetAdapter` and its types without the Markdown compiler or the
renderer, so an app can create the adapter in its entry chunk and load the
renderer lazily. The root export is unchanged and shares the same adapter module.
Rich code highlighting now uses Shiki's fine-grained core API with only the
`github-light` and `github-dark` themes, so bundlers emit 2 theme chunks instead
of every Shiki theme; every bundled language still loads on demand. A new
`codeHighlightEngine` option on `RichTopikContentProvider` and
`RichTopikThemeProvider` selects Shiki's JavaScript regular-expression engine
(`"javascript"`), which never loads WebAssembly and works under a
Content-Security-Policy without `'wasm-unsafe-eval'`; the default remains the
WebAssembly `"oniguruma"` engine.
