---
"@topik/core": minor
"@topik/cli": minor
"@topik/content-react": minor
---

Add the additive `topik-preview/1` capability with complete HTTP/SSE snapshots,
session and generation identity, compilation status, safe errors, deletion and
recovery. Preserve authored Course module/page declaration indices independently
of deterministic resource serialization. Initial source failures keep the watcher
and preview server available for correction.

Add an explicit inventory-bounded preview media adapter for images, light/dark
figures and controlled downloads. It verifies payload identity and bytes, uses
allowed-origin fetches, and revokes media when disposed. Existing authored URL
validation, legacy feed events and dependency constraints remain unchanged.
