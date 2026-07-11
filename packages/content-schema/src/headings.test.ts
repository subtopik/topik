import Markdoc from "@markdoc/markdoc";
import { describe, expect, test } from "vite-plus/test";
import { assignTopikHeadingIds } from "./headings";

describe("assignTopikHeadingIds", () => {
  test("generates GitHub-compatible IDs from formatted heading text", () => {
    const ast = Markdoc.parse("## This'll be a **Helpful** `Topik` Section!");

    expect(assignTopikHeadingIds(ast)).toEqual([
      {
        id: "thisll-be-a-helpful-topik-section",
        level: 2,
        title: "This'll be a Helpful Topik Section!",
      },
    ]);
  });

  test("suffixes duplicate generated IDs within a document", () => {
    const ast = Markdoc.parse("## Setup\n\n## Setup\n\n## Setup");

    expect(assignTopikHeadingIds(ast).map((heading) => heading.id)).toEqual([
      "setup",
      "setup-1",
      "setup-2",
    ]);
  });

  test("preserves and reserves explicit Markdoc IDs", () => {
    const ast = Markdoc.parse("## Introduction {% #start-here %}\n\n## Start Here");

    expect(assignTopikHeadingIds(ast).map((heading) => heading.id)).toEqual([
      "start-here",
      "start-here-1",
    ]);
  });
});
