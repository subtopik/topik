---
"@topik/content-react": patch
---

Quiz, tab and theme fixes:

- In a multiple-choice question, picking some of the right answers no longer counts as an incorrect attempt; only choosing a wrong answer does.
- A question recognizes a custom `TopikExplanation` or `TopikChoice` passed to `renderTopikMarkdown` or `renderTopikContent`, as it does in `TopikContent`.
- A link to an element inside a tab or code group panel that is not selected selects that tab, on load and when the fragment changes.
- A light content root nested in a dark one keeps light callout headings and badges.
- `TopikTableHeader` and `TopikTableCell` accept only a plain CSS length or percentage as `width`.
- The `renderTrustedTopikTree` documentation states that only `Topik*` link and Asset slots are sanitized.
