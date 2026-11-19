# Local preview protocol

`topik dev` compiles a project, watches its source, and serves the compiled state
to a browser application on the same machine. This page specifies that protocol,
`topik-preview/1`: the endpoints, the state envelope, the ordering guarantees, the
rules a consumer must follow, and the adapter that loads local media. Read it when
you build a preview client or use the library's `watch()` API.

The protocol is read-only. It does not affect v1 resource schemas, source writing,
or publishing.

## Capability negotiation

A consumer must negotiate the capability before it uses the protocol: request
`GET /health` and require `topik-preview/1` in `capabilities`. A package version or
the presence of Course resources is not sufficient evidence.

## Transport

The CLI binds to `127.0.0.1`. Every endpoint requires a loopback `Host` header and
refuses a browser `Origin` other than the allowed one.
`topik dev --allow-origin <origin>` selects one exact browser origin; the default
is `https://write.subtopik.com`.

| Endpoint              | Returns                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `GET /health`         | `status`, the running CLI `version`, `sessionId`, and `capabilities: ["topik-preview/1"]`     |
| `GET /resources`      | The current `PreviewState` envelope. The response is not cached.                              |
| `GET /events`         | A server-sent event stream of `preview-state` events, each carrying a complete `PreviewState` |
| `GET /blobs/<digest>` | The bytes of one payload; see [Explicit local media adapter](#explicit-local-media-adapter)   |

`GET /resources` and each `preview-state` event carry the same complete envelope.
The event stream sends the current state immediately on connection, including a
current error. There is no event replay and no Last-Event-ID history: the current
complete state supersedes older ones.

On macOS and Windows the dev server reads sources with the weaker portable file
safety and prints one notice; `--file-safety anchored` requires Linux.

## Preview state

```ts
import { TOPIK_PREVIEW_PROTOCOL, type PreviewState } from "@topik/core/preview";
```

The `@topik/core/preview` subpath is browser-safe; the main `@topik/core` entry
includes Node APIs.

| Field                | Meaning                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `protocol`           | Exact string `topik-preview/1`                                                                         |
| `sessionId`          | Random ID for this watcher/server lifetime; changes on restart                                         |
| `sequence`           | Increasing positive safe integer for every published state in this session                             |
| `generation`         | Increasing positive integer on success; `null` before any success                                      |
| `status`             | `compiling`, `ready`, or `error`                                                                       |
| `diagnostics`        | Errors and warnings with ID, message, severity, location and resource; see [Diagnostics](#diagnostics) |
| `omittedDiagnostics` | How many diagnostics did not fit in `diagnostics`; absent when all fit                                 |
| `resources`          | Array of every resource from the last successful generation                                            |
| `payloads`           | Array of every payload descriptor: `path`, `integrity`, `mediaType`, `size`, `assetNames`; no bytes    |
| `courseNavigation`   | Explicit authored declaration positions from the same generation                                       |

The subpath also exports `Resource`, the union of the schema-generated resource
types that `resources` holds by default. A client that validates each resource
itself can name its own type, as in `PreviewState<ValidatedResource>`; every other
field keeps its type.

## Diagnostics

Each state carries the diagnostics of the compilation it reports: the errors of a
failed one in an `error` state, and the warnings of a successful one in a `ready`
state, so a link that `--links warning` lets through still shows up. A `compiling`
state carries none.

```ts
interface PreviewDiagnostic {
  id: string; // stable, for example "link-page-not-found" or "TOPIK_ASSET_FILE_MISSING"
  message: string; // display text only; match on `id`
  severity?: "error" | "warning";
  location?: { path: string; line?: number; column?: number };
  resource?: { type: string; name: string };
}
```

- `location.path` is relative to the project root, as the CLI prints it, never an
  absolute path. It is the path as written, including spaces and non-ASCII
  letters. A path containing a `:`, a percent-escape such as `%2F`, a control,
  invisible or bidirectional character, or whitespace other than a space has no
  `location`. `line` and `column` start at 1 and are present when known; a
  `column` only with a `line`.
- `resource` names the resource whose source file the diagnostic is in, as of the
  last successful generation. A file that has never compiled, and every
  diagnostic before the first success, has no `resource`.
- Errors come first, each group in compiler order. A state carries at most 100
  (`PREVIEW_DIAGNOSTIC_LIMIT`) and counts the rest in `omittedDiagnostics`.
- Messages are fixed wording per ID, without exception text or authored values.
  A failure Topik cannot classify publishes `compilation-failed` without a
  location.

`topik dev` prints the same diagnostics as `path:line:column severity id: message`.

## Atomic generations and ordering

Each compilation publishes a sequence of complete states:

| Moment               | Published state                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------- |
| A compilation starts | `compiling`                                                                                  |
| It succeeds          | `ready`, after all resources, payloads and navigation are committed together                 |
| It fails             | `error`, with the previous generation's resources, payloads and navigation retained together |

- Every successful compilation advances `generation`, including one that recovers
  to identical output and one that changes only order.
- A deletion is represented by absence from the complete inventory.
- With no prior success, a failure publishes empty inventories and a `null`
  generation. This is a source failure, not an empty project. An initial failure
  does not terminate the server.

Compilations are serialized, and filesystem notifications are coalesced:

- A compilation starts once no notification has arrived for `debounceMs`
  milliseconds.
- Notifications during a running compilation are not delayed further; they cause
  one more compilation after it.
- A candidate invalidated by a notification during its compilation is discarded
  before publication.
- Closing the watcher prevents pending results from being committed.

### Watched directories

Directories named `node_modules`, `.git`, `.topik` and
`.topik-compilation-{generation,prior}-*` are ignored only below the watched
directory, so a project may itself live inside such a directory.

### Watcher failure

A filesystem watcher failure publishes `error` with diagnostic ID `watch-failed`.
The last successful generation stays available, but updates stop, because watch
coverage is not reliable after the failure. Restart the preview after resolving
the filesystem error; editing source alone does not recover the watcher.

In the library, the underlying filesystem watcher is released immediately, but
you must still call `close()`.

## The `watch()` API

`watch()` in `@topik/core` is the in-process producer behind `topik dev`.

- **Resolution.** `watch()` resolves only after the first compilation has
  finished, whether it succeeded or failed, so `watcher.state` is then `ready` or
  `error`, not the initial `compiling` state. The exception is a `signal` aborted
  before the first compilation finishes: `watch()` then resolves with a closed
  watcher whose state may be the initial one.
- **First error.** Events from the first compilation are published before `on()`
  can be called. Pass `onError` to receive its error.
- **Debounce.** `debounceMs` defaults to `DEFAULT_WATCH_DEBOUNCE_MS` (100). It
  must be an integer from 0 to 2147483647, or `watch()` rejects with a
  `RangeError` before it watches anything.
- **State.** `watcher.state` is frozen, and the watcher emits `preview-state` for
  each published state. The `watcher.resources` and `watcher.payloads`
  compatibility Maps are fully replaced before success notifications.
- **Listeners.** Listener exceptions are isolated: a throwing `preview-state` or
  `update` listener does not change compile state or skip other listeners. Its
  error is passed to `error` listeners. Exceptions thrown by `error` listeners
  are dropped.

## Course navigation order

`courseNavigation` records where each module and page was declared, so a consumer
can order them without relying on array order. `PreviewState.courseNavigation`,
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

The indices are the positions in the authored `modules[]` and each `pages[]`,
taken before resources are sorted. Standalone and manifest compilation both
preserve them.

- Every Course is present, including empty Courses.
- Every module has a `pages` array, including empty modules.
- Each module and page appears exactly once, under its actual parent.
- Indices are contiguous zero-based positions within each parent.

Sort modules by `(spec.order, declarationIndex)` and pages similarly. Never infer
ties from array serialization, Map insertion, names, titles or slugs. The resource
schemas do not include these indices. A consumer must validate both the resource
graph and the index completely before committing.

## Consumer concurrency rules

The protocol supplies producer state. The host application owns the consumer's
storage, selection, retry, accessibility and connection-epoch policies, and must
follow these rules.

Bind each connection to one session:

1. Bind each connection attempt to a local cancellation epoch.
2. After capability negotiation, bind the epoch to `/health.sessionId`. Accept only
   that session from the epoch's HTTP and SSE callbacks.
3. Reject duplicate or older sequence numbers within a session, including a
   delayed HTTP snapshot that arrives after a newer SSE event.
4. On a different session, retire the connection epoch, abort its requests, close
   its stream and dispose its media. Then reconnect and accept content under a
   fresh binding. Never accept a session switch merely because a delayed old
   callback supplies a different ID.

Validate the whole envelope before replacing storage:

- identity;
- status and generation;
- resource schemas;
- unique type/name keys;
- complete parent references;
- Course order coverage;
- matching payload descriptors.

Reject an invalid or incomplete snapshot without partially applying it.

Connectivity and compilation validity are separate. Content retained while the
state is `compiling` or `error`, or while disconnected, must be identified as
stale.

## Explicit local media adapter

The renderer's string `resolveAsset` API rejects arbitrary HTTP and blob URLs, and
authored source cannot opt into local-host access. A host that has accepted a
complete snapshot can create a separate capability that loads that snapshot's
payloads from the producer:

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

`TopikContent` also accepts `previewAssets`. Supply the adapter to the render
call, not just a provider. HTTPS assets go through the ordinary `resolveAsset` and
its validation.

### Adapter lifetime

- Keep one adapter for each accepted successful generation, and retain it while
  that generation is `compiling` or `error`.
- On a new successful generation, unmount or replace the old media render and
  dispose the old adapter.
- A `null` generation cannot create an adapter.
- Disposal aborts requests and revokes object URLs. Late results cannot create
  media.

### What the adapter admits

- Only canonical generated Asset names matched to complete descriptors receive
  local authority.
- The host origin must be an exact HTTP loopback origin, without credentials, path
  or query.
- Local URIs must be exactly `blobs/<64 lowercase hex>`. No arbitrary hosts,
  traversal, redirects or source-supplied URLs are admitted.

### Blob requests

The adapter requests each blob with CORS, omitted credentials, redirect rejection
and no cache. It binds each fetch to the snapshot with
`?sessionId=<id>&generation=<n>`.

| Request                                               | CLI response      |
| ----------------------------------------------------- | ----------------- |
| Bound to the current session and generation           | The payload bytes |
| Bound to an obsolete session or generation            | 409               |
| Without `sessionId` and `generation`                  | The payload bytes |
| For a payload that the current state does not contain | 404               |

### Verification

The adapter verifies the response URL, media type, byte size and SHA-256 before it
creates an object URL.

- It bounds retained decoded bytes to the advertised size. It cancels as soon as a
  received chunk would exceed that size, or on disposal, and rejects missing or
  truncated streams. `Content-Length` never overrides this byte limit.
- It caches successful and in-flight loads by digest and use within the adapter's
  lifetime. Rejected loads are evicted, so a later remount or revisit can retry
  without replacing the adapter.

### Rendering

- Images and light/dark figures use verified image blobs (PNG, JPEG, GIF, WebP,
  AVIF). SVG and other active media are never admitted inline.
- Asset links become buttons that fetch verified bytes and initiate a controlled
  download. They expose no navigation `href`.
- Download object URLs use `application/octet-stream` to prevent active-content
  navigation. The server response carries the advertised type, and the adapter
  verifies it.
- The generated Asset name is the download filename. Original source filenames
  are not part of this feed.
- A pending load shows a status. A fetch failure or a browser image decode
  failure shows an alert, without automatic retry loops. Other content stays
  usable.
- Resolution errors are reported through `onAssetDiagnostic`, so the host can
  explain missing media.

### Host responsibilities

The browser's Content-Security-Policy must permit `blob:` images and connections
to the configured producer. The host owns any browser local-network access
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
acceptance. A compatible published package cohort is a separate adoption
requirement: package publication and downstream dependency and peer adoption are
separate gates.

## Legacy events

`GET /events` also sends two events for clients that predate `preview-state`. They
are frozen: they will not gain fields or new event types, and they do not provide
the complete-state guarantees.

| Event    | When                                                                 | Data                                                              |
| -------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `sync`   | Once per connection, after the first `preview-state`                 | `resources` and `payloads` keyed inventories as of the connection |
| `update` | After each successful generation, once per added or changed resource | `{ key, resource }`, with `key` as `<type>/<name>`                |

Legacy events never signal a deletion. When a source file is deleted or a resource
disappears from a generation, nothing is sent on the legacy stream, so a legacy
client keeps showing the removed resource until it reconnects and receives a new
`sync`. Failed generations send no legacy event either. Clients that need correct
deletions must consume the complete `preview-state` snapshots, where a deletion is
absence from `resources`.

Select one protocol per connection. A client that uses `preview-state` must ignore
legacy events, so that an individual update cannot overwrite a complete accepted
generation. A consumer of the legacy events can keep its resource previews while
explaining that Course previews need the `topik-preview/1` capability.
