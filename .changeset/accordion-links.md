---
"@topik/content": patch
"@topik/content-react": patch
"@topik/core": patch
---

Make accordions link targets. An accordion takes an optional `id`; without one, Topik generates it from the `title` like a heading's ID, in one set of IDs with the headings and in document order. Variables in a template title do not contribute. Explicit accordion IDs use the heading ID characters (`topik-accordion-id`) and are unique across headings and accordions (`heading-id-duplicate`).

- Analysis returns `anchors`, every heading and accordion in document order with `kind` and `positional`, alongside `headings`, which stays headings only. The compiler checks link fragments against anchors, so `link-fragment-not-found` and `link-fragment-positional` cover accordions.
- The reader tree passes the ID to `TopikAccordion` as `id`. The themed accordion renders it on its `<details>` and opens when the URL fragment names it or an element inside it, on load and on fragment changes.

Breaking: `link-fragment-not-found` and `heading-id-duplicate` messages now mention accordions.
