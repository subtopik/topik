import { isTopikGeneratedAssetName } from "@topik/content";

export interface PreviewAssetInventory {
  sessionId: string;
  generation: number | null;
  resources: readonly { type: string; name: string; spec: unknown }[];
  payloads: readonly {
    path: string;
    integrity: string;
    mediaType: string;
    size: number;
    assetNames: readonly string[];
  }[];
}
/** Opaque host capability. Only createPreviewAssetAdapter can create an admitted adapter. */
export interface PreviewAssetAdapter {
  /** Abort pending loads and revoke all object URLs when replacing a snapshot/session. */
  dispose(): void;
}
type Slot = "image.src" | "figure.src" | "figure.darkSrc" | "link.href";
interface Entry {
  path: string;
  integrity: string;
  mediaType: string;
  size: number;
}
interface AdapterState {
  entries: Map<string, Entry>;
  load(name: string, slot: Slot): Promise<string>;
  active(): boolean;
}
const adapters = new WeakMap<PreviewAssetAdapter, AdapterState>();
const tokens = new WeakMap<object, { name: string; slot: Slot; state: AdapterState }>();
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Bind a validated successful preview inventory to one exact loopback producer origin. */
export function createPreviewAssetAdapter(options: {
  origin: string;
  snapshot: PreviewAssetInventory;
}): PreviewAssetAdapter {
  const origin = new URL(options.origin);
  if (
    origin.origin !== options.origin ||
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid preview origin");
  const { snapshot } = options;
  if (
    !/^[a-zA-Z0-9-]{1,128}$/u.test(snapshot.sessionId) ||
    !Number.isSafeInteger(snapshot.generation) ||
    snapshot.generation === null ||
    snapshot.generation < 1
  )
    throw new Error("A successful preview generation is required");
  // Copy only verified values. Later mutation of caller-owned JSON cannot widen authority.
  const assets = new Map<string, Entry>();
  const names = new Set<string>();
  for (const resource of snapshot.resources) {
    if (resource.type !== "Asset") continue;
    if (
      !isTopikGeneratedAssetName(resource.name) ||
      names.has(resource.name) ||
      !resource.spec ||
      typeof resource.spec !== "object"
    )
      throw new Error("Invalid preview Asset inventory");
    names.add(resource.name);
    const spec = resource.spec as Record<string, unknown>;
    // HTTPS Assets continue to use the ordinary resolver and authored URL policy.
    if (typeof spec.uri === "string" && spec.uri.startsWith("https://")) continue;
    if (
      typeof spec.uri !== "string" ||
      !/^blobs\/[0-9a-f]{64}$/u.test(spec.uri) ||
      spec.integrity !== `sha256:${spec.uri.slice(6)}` ||
      typeof spec.mediaType !== "string" ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(spec.mediaType) ||
      !Number.isSafeInteger(spec.size) ||
      (spec.size as number) < 0
    )
      throw new Error("Invalid local preview Asset");
    assets.set(resource.name, {
      path: spec.uri,
      integrity: spec.integrity as string,
      mediaType: spec.mediaType,
      size: spec.size as number,
    });
  }
  const paths = new Set<string>();
  const covered = new Set<string>();
  for (const payload of snapshot.payloads) {
    if (
      paths.has(payload.path) ||
      !/^blobs\/[0-9a-f]{64}$/u.test(payload.path) ||
      !payload.assetNames.length
    )
      throw new Error("Invalid preview payload inventory");
    paths.add(payload.path);
    for (const name of payload.assetNames) {
      const asset = assets.get(name);
      if (
        !asset ||
        covered.has(name) ||
        asset.path !== payload.path ||
        asset.integrity !== payload.integrity ||
        asset.mediaType !== payload.mediaType ||
        asset.size !== payload.size
      )
        throw new Error("Preview payload does not match Asset inventory");
      covered.add(name);
    }
  }
  if (covered.size !== assets.size) throw new Error("Incomplete preview payload inventory");
  const sessionId = snapshot.sessionId;
  const generation = snapshot.generation;
  const controller = new AbortController();
  const urls = new Set<string>();
  const pending = new Map<string, Promise<string>>();
  const state: AdapterState = {
    entries: assets,
    active: () => !controller.signal.aborted,
    load(name, slot) {
      const entry = assets.get(name);
      if (
        !entry ||
        controller.signal.aborted ||
        (slot !== "link.href" && !imageTypes.has(entry.mediaType))
      )
        return Promise.reject(new Error("Preview media unavailable"));
      // Download blobs are inert even for active media; never expose them as navigation hrefs.
      const download = slot === "link.href";
      const key = `${entry.path}/${download ? "download" : "image"}`;
      let promise = pending.get(key);
      if (!promise) {
        promise = (async () => {
          const url = new URL(`/${entry.path}`, origin);
          url.searchParams.set("sessionId", sessionId);
          url.searchParams.set("generation", String(generation));
          const response = await fetch(url, {
            mode: "cors",
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
          });
          if (
            !response.ok ||
            response.redirected ||
            response.url !== url.href ||
            response.headers.get("content-type") !== entry.mediaType
          )
            throw new Error("Preview media response was invalid");
          const bytes = await response.arrayBuffer();
          const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          if (
            bytes.byteLength !== entry.size ||
            `sha256:${digest}` !== entry.integrity ||
            controller.signal.aborted
          )
            throw new Error("Preview media response was stale or invalid");
          const objectUrl = URL.createObjectURL(
            new Blob([bytes], { type: download ? "application/octet-stream" : entry.mediaType }),
          );
          urls.add(objectUrl);
          return objectUrl;
        })();
        pending.set(key, promise);
      }
      return promise;
    },
  };
  const adapter = Object.freeze({
    dispose() {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      pending.clear();
    },
  });
  adapters.set(adapter, state);
  return adapter;
}

/** @internal Unforgeable per-slot capability; never derived from authored URLs or props. */
export function previewAssetToken(
  adapter: PreviewAssetAdapter | undefined,
  name: string,
  slot: Slot,
): object | undefined {
  const state = adapter && adapters.get(adapter);
  const entry = state?.entries.get(name);
  if (!state?.active() || !entry || (slot !== "link.href" && !imageTypes.has(entry.mediaType)))
    return;
  const token = Object.freeze({});
  tokens.set(token, { name, slot, state });
  return token;
}
/** @internal */
export function getPreviewAssetToken(value: unknown) {
  return value && typeof value === "object" ? tokens.get(value) : undefined;
}
