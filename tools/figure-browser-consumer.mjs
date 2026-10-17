import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TopikContent } from "@topik/content-react/theme";

// Exercise the installed renderer with the browser's source-set parser.
const playwrightModule = await import(pathToFileURL(process.argv[2]).href);
const { chromium } = playwrightModule.default ?? playwrightModule;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const origin = "https://reader.example";
const name = `auto-v1-${"a".repeat(52)}`;
const sources = [
  "https://images.example/dark.png 1x, http://127.0.0.1/private.png 2x",
  "https://images.example/dark.png,",
  "https://images.example/dark%20image.png?color=dark#view",
];
try {
  for (const source of [...sources, "/images/dark.png 1x, /private.png 2x"]) {
    for (const resolved of [false, true]) {
      if (!resolved && source.startsWith("/")) continue;
      const darkSource = resolved ? `asset:${name}` : source;
      const html = renderToStaticMarkup(
        createElement(TopikContent, {
          content: `{% figure src="https://images.example/light.png" darkSrc=${JSON.stringify(darkSource)} alt="Diagram" /%}`,
          ...(resolved ? { resolveAsset: () => source } : {}),
        }),
      );
      const page = await browser.newPage({ colorScheme: "dark", deviceScaleFactor: 2 });
      try {
        const images = [];
        await page.route("**/*", async (route) => {
          if (route.request().resourceType() === "document") {
            await route.fulfill({ contentType: "text/html", body: html });
          } else {
            if (route.request().resourceType() === "image") images.push(route.request().url());
            await route.fulfill({ status: 404, body: "" });
          }
        });
        await page.goto(origin);
        const expected = new URL(source.replaceAll(" ", "%20").replaceAll(",", "%2C"), origin);
        assert.equal(
          await page.locator("img").evaluate((image) => image.currentSrc),
          expected.href,
        );
        expected.hash = "";
        assert.deepEqual(images, [expected.href]);
      } finally {
        await page.close();
      }
    }
  }
  console.log("Packed figure browser checks passed");
} finally {
  await browser.close();
}
