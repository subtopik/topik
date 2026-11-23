---
"@topik/content-react": patch
---

Improve the default theme's accessibility and right-to-left layout. An explicitly
`undefined` component override now falls back to the themed component, and
`TopikTab`/`TopikCodeTab` overrides render inside the themed tab panels. Figures
whose image cannot be resolved keep their alt text and caption, and an unknown
figure `colorScheme` behaves as if none was set. An explicit `colorScheme` paints
the theme canvas behind the content. Steps, callouts and code tabs use logical
properties, code, math and diagram source stay left to right, and tab arrow keys
follow the visual order in right-to-left layouts. Tablists have accessible names,
tab panels are focusable, quiz choices are grouped in a named fieldset, repeated
wrong answers are re-announced, the Copy button is removed when the Clipboard API
is unavailable and a successful copy is announced, and renaming a tab no longer
remounts its panel.
