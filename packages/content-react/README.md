# @topik/content-react

Render Topik Markdown in React. The renderer validates source, evaluates
variables and conditions, and renders the resulting reader tree. Optional entry
points add a default theme and rich code, math, and diagram rendering.

## Install

```sh
npm install @topik/content-react@alpha react react-dom
```

Rich rendering uses optional peers: `shiki` for code highlighting, `katex` for
math, and `pele` for Mermaid-syntax diagrams. Install only the ones your content
needs.

## Usage

Import the theme stylesheet once and render a document with the themed component:

```tsx
import "@topik/content-react/theme/styles.css";
import { TopikContent } from "@topik/content-react/theme";

export function Article() {
  return <TopikContent content={"# Getting started\n\nKeep a **backup**."} />;
}
```

| Entry point                             | Provides                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `@topik/content-react`                  | `renderTopikMarkdown` and `renderTopikContent` with your components.          |
| `@topik/content-react/theme`            | `TopikContent` and the default themed components.                             |
| `@topik/content-react/theme/styles.css` | Styles for the default theme.                                                 |
| `@topik/content-react/rich`             | `RichTopikContentProvider` for Shiki, KaTeX, and Pele rendering.              |
| `@topik/content-react/rich/styles.css`  | Styles for rich components; import it with the theme stylesheet.              |
| `@topik/content-react/preview-assets`   | `createPreviewAssetAdapter` alone, without the Markdown compiler or renderer. |

Rich code highlighting uses Shiki's WebAssembly engine by default, which needs
`'wasm-unsafe-eval'` in a Content-Security-Policy `script-src`. Pass
`codeHighlightEngine="javascript"` to `RichTopikContentProvider` to use an engine
that never loads WebAssembly. See
[Code highlighting and Content-Security-Policy](https://github.com/subtopik/topik/blob/main/docs/content/rendering.md#code-highlighting-and-content-security-policy)
for the trade-offs.

## Documentation

- [Rendering](https://github.com/subtopik/topik/blob/main/docs/content/rendering.md):
  variables, invalid content, rich components, and application URLs
- [Content format](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)
- [Code presentation](https://github.com/subtopik/topik/blob/main/docs/content/code-presentation.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT
