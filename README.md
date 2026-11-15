# Topik

Topik is a Markdown content format and a set of TypeScript libraries for
validating, compiling, and rendering it. Use it for a single document or
organize many documents into guides, wikis, and courses. Topik does not provide
editing, storage, publishing, or access control; your application does.

> [!NOTE]
> Topik is alpha software. Keep related `@topik/*` packages on matching releases
> and review formatting and migration changes when upgrading.

## Packages

| Package                                          | Responsibility                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| [`@topik/content`](packages/content)             | Parse, validate, format, evaluate, and compile individual documents.   |
| [`@topik/content-react`](packages/content-react) | Render content with React, with optional themed and rich components.   |
| [`@topik/core`](packages/core)                   | Compile wikis, guide collections, and courses; validate resources.     |
| [`@topik/schema`](packages/schema)               | JSON schemas and TypeScript types for resource envelopes.              |
| [`@topik/cli`](packages/cli)                     | Compile, lint, and validate content directories from the command line. |
| [`@topik/codemod`](packages/codemod)             | Migrate existing content, such as Mintlify components, to Topik.       |
| [`@topik/remark-tags`](packages/remark-tags)     | Low-level Markdown tag syntax for remark and micromark integrations.   |

`packages/astro` contains an unpublished Astro integration used for development.

## Quick start

Validate and compile one document with `@topik/content`:

```sh
npm install @topik/content
```

```ts
import { compileTopikContent } from "@topik/content";

const compiled = compileTopikContent(
  '# Welcome\n\n{% callout variant="tip" %}\nKeep a **backup**.\n{% /callout %}',
);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
// Store the authored source; pass compiled.tree to your renderer.
```

Render it in React with `@topik/content-react`:

```tsx
import "@topik/content-react/theme/styles.css";
import { TopikContent } from "@topik/content-react/theme";

export function Article() {
  return <TopikContent content={"# Getting started\n\nKeep a **backup**."} />;
}
```

Compile a directory with a [project manifest](docs/resources/manifest.md) into
resources with the CLI:

```sh
npm install @topik/cli
npx topik compile ./handbook --validate
npx topik validate ./handbook/.topik/resources
```

## Documentation

- [Overview](docs/index.md)
- [Content format](docs/content/content-design.md), [links](docs/content/autolinks.md), [templates](docs/content/templates.md), and [code presentation](docs/content/code-presentation.md)
- [Rendering in React](docs/content/rendering.md)
- [Resources and compilation](docs/resources/index.md), [project manifest](docs/resources/manifest.md), [navigation](docs/resources/navigation.md), [source writing](docs/resources/source-writing.md), and [assets](docs/resources/assets.md)
- [`@topik/content` API reference](packages/content/README.md)

## Development

This repository is a pnpm workspace that uses the [Vite+](https://viteplus.dev/guide/)
toolchain through its `vp` command. See [AGENTS.md](AGENTS.md) for details.

```sh
vp install          # install dependencies
vp run -r build     # build every package (packages consume each other's dist)
vp check            # format, lint, and type check
vp test             # run the test suites
```

Add a changeset with `vp run changeset` for changes to published packages.

## License

[MIT](LICENSE) © The Topik Authors
