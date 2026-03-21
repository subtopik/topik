import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const runMock = vi.fn();

vi.mock("@drizzle-team/brocli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@drizzle-team/brocli")>();
  return {
    ...actual,
    run: runMock,
  };
});

describe("cli entrypoint", () => {
  beforeEach(() => {
    runMock.mockReset();
    runMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.resetModules();
  });

  test("registers the compile, dev, and validate commands with brocli", async () => {
    await import("./cli");

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]?.[0]).toHaveLength(3);
    expect(runMock.mock.calls[0]?.[1]).toMatchObject({
      name: "topik",
      description: "Topik CLI",
    });
  });
});
