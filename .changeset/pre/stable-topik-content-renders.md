---
"@topik/content-react": patch
---

Report `TopikContent` diagnostics after commit, once per compiled document, so callbacks can update state without render loops or StrictMode duplicates. Recompile only when content, file or config values change, and keep link, card, figure and choice components mounted across parent renders with new inline handlers.
