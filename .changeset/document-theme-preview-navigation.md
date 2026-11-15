---
"@topik/schema": patch
"@topik/core": patch
---

Document what the Wiki theme fields mean: `colors.light` is the brand color shown
in light mode, `colors.dark` the one shown in dark mode, and `colors.primary` the
base color used when the mode's own color is absent; `appearance.default` is the
mode a reader sees before choosing one, with `system` following the device. The
schema descriptions now carry this into the generated types, and state that the
schema does not validate legibility. Validation is unchanged.

`PreviewState` is now generic over its resource type, `PreviewState<R = Resource>`,
so a client that validates resources itself can use its own resource union without
redefining the interface; existing uses keep the same type. `@topik/core/preview`
also exports the `Resource` union. The Wiki navigation helpers document their
contract (duplicate source paths are rejected, `search` keeps existing
percent-escapes such as `?mode=%FF` byte-for-byte, `hash` is percent-encoded), and
the preview protocol documents that the legacy `sync`/`update` events are frozen
and never signal deletions, and that `watch()` resolves after the first
compilation.
