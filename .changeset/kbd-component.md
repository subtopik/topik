---
"@topik/content": patch
"@topik/content-react": patch
---

Add a `kbd` component for keys the reader presses: `Press {% kbd %}Ctrl{% /kbd %}+{% kbd %}C{% /kbd %} to copy.` It is inline, holds inline content and takes no attributes, so it works in prose, headings, lists and table cells. The theme renders `TopikKbd` as a key cap, and without a themed component it stays a semantic `<kbd>` element.

Breaking: `TopikComponentName` and `TopikComponentMap` in `@topik/content-react` gain `TopikKbd`, and an application that registered its own `kbd` in `config.components` must rename it, since the built-in schema takes its place.
