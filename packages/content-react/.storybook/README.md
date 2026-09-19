# Content React Storybook

From the repository root:

```sh
vp install
vp run --filter @topik/content-react storybook
```

Storybook resolves the content schema from workspace source, so it does not require a package build first. It imports the same theme CSS shipped to consumers. Rich stories also import the rich styles and KaTeX CSS, and use the actual optional rendering libraries installed as development dependencies.

## Writing stories

- Use typed CSF stories with `satisfies Meta<typeof Component>` and `StoryObj<typeof meta>`.
- Keep individual component states in focused files, with args and explicit controls for the generic Topik component props. Keep Markdoc integration examples under Components and TopikContent.
- Prefer named states such as Open, IncorrectAnswer, and DisplayMath. Exercise meaningful keyboard and callback behavior with `play`, `expect`, and `userEvent` from the story context.
- Use `fn()` from `storybook/test` for callback args. Example navigation is intercepted by the global provider so links do not leave the canvas.
- Reuse the local assets in `public/storybook-assets` through `src/stories/fixtures.ts`. Do not add external placeholder-image services.
- Autodocs is enabled globally. Add descriptions explaining required providers, CSS, and deliberate error scenarios.
- The Theme toolbar synchronizes CSS, asset selection, and the rich renderer. Add explicit dark and mobile stories for important regression cases; toolbar exploration alone is not automated coverage.
- Invalid Markdoc throws by default. Demonstrate safe error presentation with `invalidContent: "placeholder"`, or explicitly catch errors when documenting the throwing API.

## Verification

```sh
vp exec --filter @topik/content-react playwright install chromium
vp run --filter @topik/content-react storybook:test
vp run --filter @topik/content-react storybook:build
```

Browser tests use the Storybook Vitest addon and Vite+'s Playwright provider. Their separate `.storybook/vite.config.mjs` keeps the existing fast unit tests independent of browser installation. The package's main Vite config also selects it when the Storybook test panel sets `VITEST_STORYBOOK`. Storybook 10.6 applies preview annotations automatically; no duplicate setup file is needed.

The addon needs a directly resolvable `vitest` dependency for browser dependency optimization. Keep it and `@vitest/browser-playwright` aligned with the Vitest version reported by `vp toolchain` when upgrading Vite+. Commands still run through `vp test`.

Accessibility violations fail browser tests through `a11y.test: "error"`. CI runs the browser tests and static build in a dedicated job and uploads the built Storybook for review. Automated accessibility checks complement manual keyboard, contrast, and responsive inspection; the build artifact can be served locally with any static file server.

These checks cover rendering, behavior, and accessibility. They do not maintain screenshot baselines; review visual changes in Storybook before merging.
