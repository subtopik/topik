import { describe, expect, it, vi } from "vite-plus/test";
import { createTopikLinkResolver } from "./links";

describe("createTopikLinkResolver", () => {
  it("resolves names through entry metadata and application-specific routes", () => {
    const resolveLink = createTopikLinkResolver({
      wikiPages: [{ id: "welcome-page", data: { slug: "", wiki: "docs" } }],
      guides: [{ id: "guide-name", data: { slug: "published-slug" } }],
      coursePages: [
        { id: "lesson-name", data: { slug: "setup", module: "basics", course: "tools" } },
      ],
      resolveWikiPage: (entry) => `/manual/${entry.data.wiki}/${entry.data.slug}`,
      resolveGuide: (entry) => `/learn/${entry.data.slug}`,
      resolveCoursePage: (entry) =>
        `/courses/${entry.data.course}/${entry.data.module}/${entry.data.slug}`,
    });

    expect(resolveLink("ref://wiki-page/welcome-page#intro")).toBe("/manual/docs/#intro");
    expect(resolveLink("ref://guide/guide-name?view=full#setup")).toBe(
      "/learn/published-slug?view=full#setup",
    );
    expect(resolveLink("ref://guide/published-slug")).toBeUndefined();
    expect(resolveLink("ref://course-page/lesson-name#start")).toBe(
      "/courses/tools/basics/setup#start",
    );
    expect(resolveLink("ref://course-page/setup")).toBeUndefined();
    expect(resolveLink("https://example.com/help#topic")).toBe("https://example.com/help#topic");
  });

  it("keeps resource types separate and does not use repository names", () => {
    const resolveLink = createTopikLinkResolver({
      wikiPages: [{ id: "same-name", data: { slug: "overview" } }],
      guides: [{ id: "same-name", data: { slug: "tutorial" } }],
      coursePages: [{ id: "same-name", data: { slug: "lesson" } }],
      resolveWikiPage: (entry) => `/docs/${entry.data.slug}`,
      resolveGuide: (entry) => `/guides/${entry.data.slug}`,
      resolveCoursePage: (entry) => `/courses/${entry.data.slug}`,
    });

    expect(resolveLink("ref://wiki-page/same-name")).toBe("/docs/overview");
    expect(resolveLink("ref://guide/same-name")).toBe("/guides/tutorial");
    expect(resolveLink("ref://course-page/same-name")).toBe("/courses/lesson");
  });

  it("applies CoursePage reference suffixes over application route defaults", () => {
    const resolveLink = createTopikLinkResolver({
      coursePages: [{ id: "lesson-name", data: { slug: "setup" } }],
      resolveCoursePage: (entry) => `/courses/${entry.data.slug}?view=default#overview`,
    });

    expect(resolveLink("ref://course-page/lesson-name")).toBe(
      "/courses/setup?view=default#overview",
    );
    expect(resolveLink("ref://course-page/lesson-name?view=full#start")).toBe(
      "/courses/setup?view=full#start",
    );
    for (const query of ["?q=%E9", "?discount=25%", "?q=%zz&q=a+b"]) {
      expect(resolveLink(`ref://course-page/lesson-name${query}#start`)).toBe(
        `/courses/setup${query}#start`,
      );
    }
  });

  it("refuses missing or throwing CoursePage callbacks without using a matching Guide", () => {
    const onDiagnostic = vi.fn();
    const options = {
      coursePages: [{ id: "same-name", data: { slug: "lesson" } }],
      guides: [{ id: "same-name", data: { slug: "tutorial" } }],
      resolveGuide: () => "/guides/tutorial",
      onDiagnostic,
    };
    expect(createTopikLinkResolver(options)("ref://course-page/same-name")).toBeUndefined();
    expect(
      createTopikLinkResolver({
        ...options,
        resolveCoursePage: () => {
          throw new Error("private course catalogue failure");
        },
      })("ref://course-page/same-name"),
    ).toBeUndefined();
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    expect(onDiagnostic).toHaveBeenCalledWith({
      id: "TOPIK_RESOURCE_REFERENCE_UNRESOLVED",
      message: "Resource reference could not be resolved to a browser URL",
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain(
      "private course catalogue failure",
    );
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
