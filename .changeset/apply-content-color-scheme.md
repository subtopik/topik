---
"@topik/content-react": patch
---

Apply an explicit `colorScheme` to the theme stylesheet through `data-theme` on the `TopikContent` root, let `data-theme="light"` override a `.dark` ancestor, and use the provider color scheme for rich code and diagrams when `RichTopikContentProvider` has no `theme`.
