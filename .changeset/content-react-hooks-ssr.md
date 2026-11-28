---
"@topik/content-react": patch
---

Fix tablist lifecycle, SSR layout effects, and React hook lint suppressions. `TopikTablist` now attaches `hashchange` via its outer container ref so empty-mounted tablists respond once populated, cancels pending `requestAnimationFrame` callbacks on reschedule and unmount, and memoizes `selectTab`. `TopikVideo`, `CodeBlockView`, `TopikContent`, and `PreviewMedia` remove render-time ref writes, `setState`-in-effect hydration flags, and SSR `useLayoutEffect` warnings.
