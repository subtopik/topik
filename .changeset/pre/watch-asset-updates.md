---
"@topik/core": patch
"@topik/cli": patch
---

- The watcher's `update` event fires for an Asset only when its own payload changes. Editing a page no longer also re-sends every unchanged Asset, and `topik dev` no longer prints an `Updated Asset/…` line for each one.
- `topik dev` accepts any number of preview clients without Node.js warning about a possible EventEmitter memory leak.
