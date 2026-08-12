import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { PublicCompileError } from "@topik/core";
import { CliError, formatPublicCliError, PublicCliError } from "./errors";

const runMock = vi.fn();

vi.mock("@drizzle-team/brocli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@drizzle-team/brocli")>();
  return {
    ...actual,
    run: runMock,
  };
});

describe("cli entrypoint", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    runMock.mockReset();
    runMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
    vi.resetModules();
  });

  test("registers the compile, dev, lint, and validate commands with brocli", async () => {
    await import("./cli");

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]?.[0]).toHaveLength(4);
    expect(runMock.mock.calls[0]?.[1]).toMatchObject({
      name: "topik",
      description: "Topik CLI",
    });
  });

  test("prints a generic failure for unknown recursive errors", async () => {
    const sentinel = "PRIVATE_VALUE";
    const output: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values) => {
      output.push(values.map(String).join(" "));
    });
    runMock.mockRejectedValue(
      new Error(`Failure at /tmp/${sentinel}`, {
        cause: new Error(`Nested ${sentinel}`),
      }),
    );

    await import("./cli");

    expect(output).toEqual(["Topik command failed."]);
    expect(JSON.stringify(output)).not.toContain(sentinel);
    expect(process.exitCode).toBe(1);
  });

  test("does not trust arbitrary CliError messages or recursive causes", async () => {
    const sentinel = "PRIVATE_VALUE";
    const output: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values) => {
      output.push(values.map(String).join(" "));
    });
    runMock.mockRejectedValue(
      new CliError(`Failure at /tmp/${sentinel}`, {
        cause: new Error(`Nested ${sentinel}`),
      }),
    );

    await import("./cli");

    expect(output).toEqual(["Topik command failed."]);
    expect(JSON.stringify(output)).not.toContain(sentinel);
    expect(process.exitCode).toBe(1);
  });

  test("derives trusted presentation from fixed catalog IDs instead of mutable messages", () => {
    const sentinel = "PRIVATE_VALUE";
    const cliError = new PublicCliError("resource-access-failed");
    const coreError = new PublicCompileError("config-not-found");
    cliError.message = sentinel;
    coreError.message = sentinel;

    expect(formatPublicCliError(cliError)).toBe("Resource input could not be accessed.");
    expect(formatPublicCliError(coreError)).toBe("Required configuration file was not found.");

    Object.defineProperty(cliError, "id", { value: sentinel });
    Object.defineProperty(coreError, "id", { value: sentinel });
    expect(formatPublicCliError(cliError)).toBe("Topik command failed.");
    expect(formatPublicCliError(coreError)).toBe("Topik command failed.");
  });
});
