import { describe, expect, test } from "vite-plus/test";
import { formatValidationFailure } from "./validation-output";

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
});
