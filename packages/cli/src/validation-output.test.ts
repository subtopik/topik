import { describe, expect, test } from "vite-plus/test";
import { formatUnreadableResourceFile, formatValidationFailure } from "./validation-output";

describe("formatValidationFailure", () => {
  test("renders detailed validation output with a summary line", () => {
    expect(
      formatValidationFailure(
        [{ resource: "Wiki/docs", path: "/spec/title", message: "must be string" }],
        2,
        "validating resources",
      ),
    ).toBe(
      "Wiki/docs: /spec/title must be string\n\n1 validation error(s) in 2 resources while validating resources",
    );
  });

  test("reduces untrusted labels, pointers, and messages to safe text", () => {
    const sentinel = "PRIVATE VALUE";
    const output = formatValidationFailure(
      [
        {
          file: `/home/user/${sentinel}/wiki.json`,
          resource: `Wiki/${sentinel}`,
          path: `/spec/${sentinel}/title`,
          message: `bad\u001b[31m${sentinel}`,
        },
        {
          file: "resources/Other.json",
          id: "resource-unsupported-type",
          resource: `${sentinel}/docs`,
          path: "/type",
          message: `Unsupported resource type: ${sentinel}`,
        },
        {
          file: "resources/Wiki/docs.json",
          id: "resource-unsupported-version",
          resource: "Wiki/docs",
          path: "/apiVersion",
          message: `Unsupported Wiki apiVersion: ${sentinel}`,
        },
      ],
      3,
      "validating resources",
    );

    expect(output).toBe(
      [
        "resource file: Wiki/unknown: /spec is invalid",
        "resources/Other.json: unknown/docs: /type Unsupported resource type",
        "resources/Wiki/docs.json: Wiki/docs: /apiVersion Unsupported resource apiVersion",
        "",
        "3 validation error(s) in 3 resources while validating resources",
      ].join("\n"),
    );
    expect(output).not.toContain(sentinel);
  });

  test("names an unreadable resource file with its safe label only", () => {
    const sentinel = "PRIVATE VALUE";
    expect(formatUnreadableResourceFile(`/home/user/${sentinel}.json`, new Error(sentinel))).toBe(
      "resource file: Topik command failed.",
    );
  });
});
