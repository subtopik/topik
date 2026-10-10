import { describe, expect, it, vi } from "vite-plus/test";
import { createTopikLinkResolver } from "./links";

describe("createTopikLinkResolver", () => {
  it("resolves names through entry metadata and application-specific routes", () => {
    const resolveLink = createTopikLinkResolver({
      wikiPages: [{ id: "welcome-page", data: { slug: "", wiki: "docs" } }],
      guides: [{ id: "guide-name", data: { slug: "published-slug" } }],
      resolveWikiPage: (entry) => `/manual/${entry.data.wiki}/${entry.data.slug}`,
      resolveGuide: (entry) => `/learn/${entry.data.slug}`,
    });

    expect(resolveLink("ref://wiki-page/welcome-page#intro")).toBe("/manual/docs/#intro");
    expect(resolveLink("ref://guide/guide-name?view=full#setup")).toBe(
      "/learn/published-slug?view=full#setup",
    );
    expect(resolveLink("ref://guide/published-slug")).toBeUndefined();
    expect(resolveLink("https://example.com/help#topic")).toBe("https://example.com/help#topic");
  });

  it("keeps resource types separate and does not use repository names", () => {
    const resolveLink = createTopikLinkResolver({
      wikiPages: [{ id: "same-name", data: { slug: "overview" } }],
      guides: [{ id: "same-name", data: { slug: "tutorial" } }],
      resolveWikiPage: (entry) => `/docs/${entry.data.slug}`,
      resolveGuide: (entry) => `/guides/${entry.data.slug}`,
    });

    expect(resolveLink("ref://wiki-page/same-name")).toBe("/docs/overview");
    expect(resolveLink("ref://guide/same-name")).toBe("/guides/tutorial");
  });

  it.each([
    undefined,
    () => undefined,
    () => "ref://guide/other-name",
    () => "javascript:alert(1)",
    () => {
      throw new Error("private catalogue failure");
    },
  ])("reports generic diagnostics for missing or unsafe route mappings", (resolveGuide) => {
    const onDiagnostic = vi.fn();
    const resolveLink = createTopikLinkResolver({
      guides: [{ id: "guide-name", data: { slug: "published-slug" } }],
      resolveGuide,
      onDiagnostic,
    });

    expect(resolveLink("ref://guide/guide-name")).toBeUndefined();
    expect(onDiagnostic).toHaveBeenCalledWith({
      id: "TOPIK_RESOURCE_REFERENCE_UNRESOLVED",
      message: "Resource reference could not be resolved to a browser URL",
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("private catalogue failure");
  });

  it("rejects an ambiguous resource catalogue", () => {
    expect(() =>
      createTopikLinkResolver({
        guides: [
          { id: "same-name", data: { slug: "first" } },
          { id: "same-name", data: { slug: "second" } },
        ],
      }),
    ).toThrow("Resource catalogue contains duplicate names for a resource type");
  });
});
