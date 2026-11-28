// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { TopikContent } from "./TopikContent";

it("reports diagnostics once while server rendering, where no effect runs", () => {
  expect(typeof document).toBe("undefined");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const onAssetDiagnostic = vi.fn();
  const onLinkDiagnostic = vi.fn();
  const onDiagnostic = vi.fn();
  try {
    renderToStaticMarkup(
      <>
        <TopikContent
          content={`[Wiki](ref://wiki-page/missing)\n\n![Hero](asset:auto-v1-${"a".repeat(52)})`}
          onAssetDiagnostic={onAssetDiagnostic}
          onLinkDiagnostic={onLinkDiagnostic}
        />
        <TopikContent
          content='{% mystery private="opaque" /%}'
          invalidContent="placeholder"
          onDiagnostic={onDiagnostic}
        />
      </>,
    );
    expect(onAssetDiagnostic).toHaveBeenCalledTimes(1);
    expect(onLinkDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});
