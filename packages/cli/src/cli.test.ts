import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { BroCliConfig, BroCliEvent } from "@drizzle-team/brocli";
import { PublicCompileError } from "@topik/core";
import packageJson from "../package.json";
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

  test("registers the compile, dev, format, init, lint, migrate, and validate commands with brocli", async () => {
    await import("./cli");

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(
      (runMock.mock.calls[0]?.[0] as { name: string }[] | undefined)?.map(({ name }) => name),
    ).toEqual(["compile", "dev", "format", "init", "lint", "migrate", "validate"]);
    expect(runMock.mock.calls[0]?.[1]).toMatchObject({
      name: "topik",
      description: "Topik CLI",
      version: packageJson.version,
    });
  });

  test("routes brocli handler failures through the public error formatter", async () => {
    const sentinel = "PRIVATE_VALUE";
    const output: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values) => {
      output.push(values.map(String).join(" "));
    });

    await import("./cli");
    // The entrypoint was imported after a module reset; use its own error class.
    const { PublicCliError: EntrypointPublicCliError } = await import("./errors");
    const theme = (runMock.mock.calls[0]?.[1] as BroCliConfig | undefined)?.theme;
    const unknownError = (error: unknown): BroCliEvent => ({
      type: "error",
      violation: "unknown_error",
      name: "topik",
      description: "Topik CLI",
      error,
    });

    expect(await theme?.(unknownError(new Error(`listen EADDRINUSE /tmp/${sentinel}`)))).toBe(true);
    expect(await theme?.(unknownError(new EntrypointPublicCliError("dev-port-invalid")))).toBe(
      true,
    );
    expect(await theme?.({ type: "version", name: "topik", description: undefined })).toBe(false);
    expect(output).toEqual([
      "Topik command failed.",
      "Dev server port must be an integer from 0 to 65535.",
    ]);
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
