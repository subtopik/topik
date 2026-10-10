import { expect, test } from "vite-plus/test";
import {
  resolveCourseContentHref,
  resolveCourseContentReference,
  resolveCourseNavigation,
  type CourseReferenceContext,
} from "./course-navigation";

const context: CourseReferenceContext = {
  course: "learning",
  modules: [{ name: "module", slug: "basics" }],
  pages: [
    { name: "intro", module: "module", slug: "welcome", sourcePath: "pages/intro" },
    { name: "target", module: "module", slug: "destination", sourcePath: "moved/target" },
  ],
};

test("resolves Course source paths and public routes independently while retaining query and fragment", () => {
  const resolved = resolveCourseNavigation(context);
  for (const href of [
    "../moved/target.md?mode=full#details",
    "/basics/destination?mode=full#details",
    "/moved/target.mdx?mode=full#details",
  ]) {
    expect(resolveCourseContentHref(href, "intro", resolved)).toMatchObject({
      page: { page: "target", sourcePath: "moved/target" },
      route: "basics/destination",
      search: "?mode=full",
      hash: "details",
    });
  }
  expect(resolveCourseContentHref("#welcome", "intro", resolved)).toMatchObject({
    page: { page: "intro" },
    hash: "welcome",
  });
  expect(resolveCourseContentHref("?mode=full#details", "target", resolved)).toMatchObject({
    page: { page: "target" },
    search: "?mode=full",
    hash: "details",
  });
});

test("unknown Course context remains unresolved and compiled Assets and external references remain distinct", () => {
  const resolved = resolveCourseNavigation(context);
  expect(resolveCourseContentReference("asset:logo", "intro", resolved)).toEqual({ kind: "asset" });
  expect(resolveCourseContentReference("https://example.org/a", "intro", resolved)).toEqual({
    kind: "external",
  });
  for (const href of ["/moved/target", "missing.md", "logo.png", "/%invalid"])
    expect(resolveCourseContentReference(href, "intro", resolved)).toEqual({ kind: "unresolved" });
  expect(resolveCourseContentReference("#details", "missing", resolved)).toEqual({
    kind: "unresolved",
  });
});

test("literal hash characters in Course source paths remain path data when resolving relative links", () => {
  const resolved = resolveCourseNavigation({
    ...context,
    pages: [
      { ...context.pages[0], sourcePath: "part#1/intro#file" },
      { ...context.pages[1], sourcePath: "part#1/next" },
    ],
  });
  for (const href of ["./next.md?mode=full#details", "/part%231/next.md?mode=full#details"]) {
    expect(resolveCourseContentHref(href, "intro", resolved)).toMatchObject({
      page: { page: "target", sourcePath: "part#1/next" },
      route: "basics/destination",
      search: "?mode=full",
      hash: "details",
    });
  }
  expect(resolveCourseContentHref("?mode=self#intro", "intro", resolved)).toMatchObject({
    page: { page: "intro", sourcePath: "part#1/intro#file" },
    search: "?mode=self",
    hash: "intro",
  });
});

test("Course reference context refuses duplicate identity, membership, routes and aliased source paths", () => {
  const invalid: CourseReferenceContext[] = [
    { ...context, modules: [...context.modules, context.modules[0]] },
    { ...context, pages: [...context.pages, context.pages[0]] },
    { ...context, pages: [{ ...context.pages[0], module: "missing" }] },
    { ...context, pages: [context.pages[0], { ...context.pages[1], slug: "welcome" }] },
    { ...context, pages: [context.pages[0], { ...context.pages[1], sourcePath: "Pages/other" }] },
    { ...context, pages: [{ ...context.pages[0], sourcePath: "../outside" }] },
  ];
  for (const value of invalid) expect(() => resolveCourseNavigation(value)).toThrow();
});
