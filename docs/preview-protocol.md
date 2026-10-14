# Local preview protocol

`topik-preview/1` is an additive read-only preview capability. It does not change
v1 resource schemas, source writing, or publishing. Consumers must negotiate the
capability; a package version or the presence of Course resources is insufficient.
A compatible published package cohort is a separate adoption requirement.

## Transport

`GET /health` returns `status`, the running CLI `version`, `sessionId`, and
`capabilities: ["topik-preview/1"]`. Existing loopback Host checks and configured
allowed-Origin checks apply to every endpoint. `topik dev --allow-origin <origin>`
selects one exact browser origin (default `https://write.subtopik.com`). The CLI
binds to `127.0.0.1`. The current safe source reader requires Linux.

`GET /resources` and each `preview-state` event on `GET /events` carry the same
complete `PreviewState` envelope. HTTP is not cached. SSE sends the current state
immediately on connection, including an existing error. No event replay or
Last-Event-ID history is needed: the current complete state supersedes older ones.

```ts
import { TOPIK_PREVIEW_PROTOCOL, type PreviewState } from "@topik/core/preview";
```

This subpath is browser-safe. The main `@topik/core` entry includes Node APIs.

| Field              | Meaning                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `protocol`         | Exact string `topik-preview/1`                                                         |
| `sessionId`        | Random ID for this watcher/server lifetime; changes on restart                         |
| `sequence`         | Increasing positive safe integer for every published state in this session             |
| `generation`       | Increasing positive integer on success; `null` before any success                      |
| `status`           | `compiling`, `ready`, or `error`                                                       |
| `diagnostics`      | Safe `{id, message}` errors, without exception text or source paths                    |
| `resources`        | Complete resource array from the last successful generation                            |
| `payloads`         | Complete descriptors: `path`, `integrity`, `mediaType`, `size`, `assetNames`; no bytes |
| `courseNavigation` | Explicit authored declaration positions from the same generation                       |

The existing `/resources.resources` and `/resources.payloads` array shapes remain.
Legacy `sync` (keyed inventories) and `update` (individual resources) events remain
for existing clients. They do not provide the complete-state guarantees. Select
one protocol per connection; a capable client must ignore legacy events so an
individual update cannot overwrite a complete accepted generation. Consumers of
older feeds can keep existing resource previews while explaining that Course
previews need the new capability.

## Atomic generations and ordering

A compile start publishes `compiling`. Success commits all resources, payloads and
navigation before publishing `ready`. Deletions are represented by absence from
the complete inventory. Every successful compile advances generation, including
identical recovery and order-only changes. Failures publish `error` and retain the
previous generation's resources, payloads and navigation together. With no prior
success those inventories are empty and generation is null; this is a source
failure, not an empty project. The initial failure does not terminate the server.

Compilations are serialized and filesystem notifications coalesced. A candidate
invalidated by a notification during compilation is discarded before publication.
Closing the watcher prevents pending results from being committed. The in-process
`watcher.state` is frozen and the watcher emits `preview-state`; compatibility Maps
are fully replaced before success notifications.

`CompileResult.courseNavigation` and discovery's `courseNavigation` carry:

```json
{
  "course-name": {
    "modules": [
      {
        "name": "module-name",
        "declarationIndex": 0,
        "pages": [{ "name": "page-name", "declarationIndex": 0 }]
      }
    ]
  }
}
```

Course discovery records indices from `modules[]` and each `pages[]` before
resource sorting. Standalone and manifest compilation preserve them. Every Course
is present, including empty Courses; every module has a pages array, including
empty modules. Each module/page appears exactly once under its actual parent.
Indices are contiguous zero-based positions within each parent. Sort modules by
`(spec.order, declarationIndex)` and pages similarly; never infer ties from array
serialization, Map insertion, names, titles or slugs. The resource schemas do not
change. A consumer must validate both graph and index completely before committing.

## Consumer concurrency rules

Bind each connection attempt to a local cancellation epoch. After capability
negotiation bind it to `/health.sessionId`; accept only that session from its HTTP
and SSE callbacks. Reject duplicate or older sequence numbers within a session,
including a delayed HTTP snapshot after a newer SSE event. On a different session,
retire the connection epoch, abort its requests, close its stream and dispose its
media before reconnecting/accepting content under a fresh binding. Never accept a
session switch merely because a delayed old callback supplies a different ID.

Validate the whole envelope before replacing storage: identity, status/generation,
resource schemas, unique type/name keys, complete parent references, Course order
coverage and matching payload descriptors. Reject invalid or incomplete snapshots
without partially applying them. Connectivity and compilation validity are separate:
retained content during compiling/error/disconnect must be identified as stale.
This protocol supplies producer state; the host owns these consumer storage,
selection, retry, accessibility and connection-epoch policies.

## Explicit local media adapter

The renderer's string `resolveAsset` API continues to reject arbitrary HTTP and
blob URLs. Authored source cannot opt into local-host access. A host that has
accepted a complete snapshot may create a separate capability:

```ts
import { createPreviewAssetAdapter, renderTopikContent } from "@topik/content-react";

const previewAssets = createPreviewAssetAdapter({
  origin: "http://127.0.0.1:50001",
  snapshot: acceptedState,
});
const content = renderTopikContent(compiledContent, {
  components,
  previewAssets,
  onAssetDiagnostic: showAssetDiagnostic,
});
// On replacing the successful generation or leaving/switching the session:
previewAssets.dispose();
```

`TopikContent` also accepts `previewAssets`. Keep one adapter for an accepted
successful generation; retain it while that generation is compiling/error. On a
new successful generation, unmount/replace the old media render and dispose the
old adapter. Supply the adapter to the render call, not just a provider. A null
generation cannot create an adapter. HTTPS assets still use ordinary
`resolveAsset` and its existing validation.

Only canonical generated Asset names matched to complete descriptors receive
local authority. The host origin must be an exact HTTP loopback origin, without
credentials, paths or query. Local URIs must be exactly `blobs/<64 lowercase hex>`;
no arbitrary hosts, traversal, redirects or source-supplied URLs are admitted.
Requests use CORS, omitted credentials, redirect rejection and no cache. Fetches
bind `?sessionId=<id>&generation=<n>`; the CLI returns 409 for obsolete identities.
Legacy unbound blob requests remain supported. Removed payloads return 404.

The adapter verifies response URL, media type, byte size and SHA-256 before
creating an object URL. It bounds retained decoded bytes to the advertised size,
cancels as soon as a received chunk would exceed that size or on disposal, and
rejects missing/truncated streams. Content-Length never overrides this byte limit. It caches successful and
in-flight loads by digest and use within that adapter lifetime; rejected loads
are evicted so a later remount or revisit can retry without replacing the adapter.
Images and light/dark figures use verified image blobs (PNG, JPEG, GIF, WebP, AVIF).
SVG and other active media are never admitted inline. Asset links become buttons
that fetch verified bytes and initiate a controlled download; they expose no
navigation href. Download object URLs use `application/octet-stream` to prevent
active-content navigation, while the server response retains and the adapter
verifies the advertised type. The generated Asset name is the download filename;
original source filenames are not part of this feed.

Pending loads show a status, fetch and browser image decode failures show an alert
without automatic retry loops, and resolution errors
continue through `onAssetDiagnostic` so the host can explain missing media. Other
content stays usable. Disposal aborts requests and revokes object URLs; late
results cannot create media. Browser CSP must permit `blob:` images and connection
to the configured producer. The host still owns any browser local-network access
permission and its session-switch presentation.

## Validation and release

Unit tests cover compiler order, order-only publication, deletion, initial/ongoing
failure recovery, in-flight invalidation/close, wire agreement and media boundaries.
`vp run verify:public-packages` also runs a clean packed-CLI Chromium consumer with
allowed-origin image/figure loading, controlled download byte equality, SSE/HTTP
ordering, reconnect, source errors and deletion. Install its browser with
`vp exec playwright install --with-deps chromium` in `packages/content-react`.
An existing Chromium can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
This upstream verification does not prove a downstream application's end-to-end
acceptance. Package publication and downstream dependency/peer adoption remain
separate gates; no peer or package pins are loosened here.
