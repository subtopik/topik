---
"@topik/core": patch
"@topik/cli": patch
---

`topik dev` sends only `preview-state` events, and the watcher publishes only its state.

Breaking: the `sync` and `update` events are removed from `GET /events`, as part of `topik-preview/2`. `Watcher.resources`, the watcher's `update` event and the `UpdateListener` type are removed; read `watcher.state.resources` and listen for `preview-state`. `Watcher.payloads` is now read-only and holds the bytes of the payloads in `state.payloads`. `topik dev` prints the resource count for each new generation instead of one line per changed resource.
