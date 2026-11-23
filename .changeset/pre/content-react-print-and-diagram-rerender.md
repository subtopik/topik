---
"@topik/content-react": patch
---

Add print styles to the theme and rich stylesheets: light colors on paper,
hidden copy, wrap and fold controls, printed collapsed code lines, wrapped long
code lines, accordions printed open where `::details-content` is supported, and
fewer awkward page breaks. Mermaid diagrams keep showing the previous diagram,
marked `aria-busy`, while changed source re-renders instead of flashing the
loading placeholder. `TopikTabs` and `TopikCodeGroup` now share one tablist
implementation with unchanged markup and keyboard behaviour.
