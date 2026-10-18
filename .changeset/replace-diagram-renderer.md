---
"@topik/content-react": minor
---

Render Mermaid fences with the optional Pele 1.6.0 peer instead of Mermaid.js. Existing component names and source syntax remain unchanged; consumers must replace their optional Mermaid dependency with Pele. Preserve loading/source fallbacks and isolated light/dark themes, disable diagram links and images, and validate generated SVG before insertion. Pele has different layouts and does not support Mermaid themeVariables, arbitrary HTML labels, or plugins.
