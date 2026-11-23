---
"@topik/content-react": patch
---

Fix several rendering issues. The root entry marks its provider, hooks and preview media
as client modules in the build, so `renderTopikMarkdown`, `renderTopikContent`
and `compileTopikContent` import under the `react-server` condition. A pending
preview download is no longer dropped when the parent re-renders with inline
resolvers. `onDiagnostic` reports thrown content once, from a layout effect
before the error, instead of repeatedly during render. `RichTopikCodeBlock`
renders string children like `TopikCodeBlock`. The Mermaid loading placeholder is
a `status` with announced text, and task-list checkboxes have accessible names.
The diagram boundary drops author class names outside Pele's `pele-*` namespace
and style declarations other than presentation properties.
