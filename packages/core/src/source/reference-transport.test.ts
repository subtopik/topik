import { expect, test } from "vite-plus/test";
import {
  transportSavedReferences,
  type SavedReferenceLink,
  type SavedReferenceTransport,
  type SavedReferenceTransportFailure,
  type SourceDerivedRepair,
} from "./reference-transport";

class TransportFailure extends Error {
  constructor(readonly reason: SavedReferenceTransportFailure) {
    super(reason);
  }
}

/** Saved links name pages by `old-<page>`; current links by `/new/<page>`. */
function transport(
  content: string,
  overrides: Partial<SavedReferenceTransport<SavedReferenceLink>> = {},
  routes: Record<string, string> = { a: "new/a", b: "new/b" },
) {
  const repairs: SourceDerivedRepair[] = [];
  const link = (page: string): SavedReferenceLink => ({ page: { page }, search: "", hash: "" });
  const result = transportSavedReferences({
    resource: "WikiPage/home",
    content,
    resolveSaved: (href) => {
      const match = /^\.\/old-([a-z]+)\.md$/.exec(href);
      return match ? { kind: "page", target: link(match[1]) } : { kind: "unresolved" };
    },
    resolveCurrent: (href) => {
      const match = /^\/new\/([a-z]+)$/.exec(href);
      return match && routes[match[1]] ? link(match[1]) : null;
    },
    currentRoute: (page) => routes[page],
    repairs,
    fail: (reason) => {
      throw new TransportFailure(reason);
    },
    ...overrides,
  });
  return { ...result, repairs };
}

test("a moved page target is rewritten to its current route and reported", () => {
  const result = transport("See [A](./old-a.md).\n");
  expect(result.changed).toBe(true);
  expect(result.content).toContain("[A](/new/a)");
  expect(result.repairs).toEqual([
    expect.objectContaining({
      resource: "WikiPage/home",
      kind: "reference",
      before: "./old-a.md",
      after: "/new/a",
      target: "a",
    }),
  ]);
});

test("a link that already resolves identically is kept unless the target is shadowed", () => {
  const kept = transport("See [A](/new/a).\n", {
    resolveSaved: () => ({ kind: "page", target: { page: { page: "a" }, search: "", hash: "" } }),
  });
  expect(kept.changed).toBe(false);
  expect(kept.repairs).toEqual([]);
  const shadowed = transport("See [A](/new/a).\n", {
    resolveSaved: () => ({ kind: "page", target: { page: { page: "a" }, search: "", hash: "" } }),
    isCurrentShadowed: (_, current) => current?.page.page === "a",
  });
  expect(shadowed.repairs).toHaveLength(1);
});

test("non-page and other references bypass saved navigation", () => {
  expect(transport("See [file](./old-a.md).\n", { isNonPageReference: () => true }).changed).toBe(
    false,
  );
  const other = transport("See [x](./elsewhere.md).\n", {
    resolveOtherReference: () => "../elsewhere.md",
  });
  expect(other.content).toContain("[x](../elsewhere.md)");
});

test("each failure reaches the caller's own diagnostic", () => {
  expect(() => transport("See [x](./missing.md).\n")).toThrow(
    expect.objectContaining({ reason: "unresolved" }),
  );
  expect(() => transport("See [A](./old-a.md).\n", {}, { b: "new/b" })).toThrow(
    expect.objectContaining({ reason: "removed" }),
  );
  expect(() => transport("See [A](./old-a.md).\n", { resolveCurrent: () => null })).toThrow(
    expect.objectContaining({ reason: "unrepresentable" }),
  );
});
