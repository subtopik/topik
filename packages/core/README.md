# @topik/core

Compile directories of Topik Markdown into typed resources. `@topik/core`
compiles wikis, guide collections, and courses declared in a project manifest,
generates asset resources for local images and downloads, validates resource
envelopes, and resolves wiki and course navigation.

To render a single document, start with
[`@topik/content`](https://github.com/subtopik/topik/tree/main/packages/content)
or [`@topik/content-react`](https://github.com/subtopik/topik/tree/main/packages/content-react)
instead.

## Install

```sh
npm install @topik/core
```

## Usage

Compile a directory that contains `wiki.yaml` and its pages, then validate the
generated resources:

```ts
import { compileWiki, validateResources } from "@topik/core";

const result = await compileWiki({ dir: "./handbook" });
const validation = validateResources(result.resources);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
console.log(result.resources.map((resource) => `${resource.type}/${resource.name}`));
```

Use `compile` for the sources declared in `.topik.yaml` and `compileGuides` for a
standalone guide collection. The result also contains asset payloads,
diagnostics, and compilation inventories. Navigation helpers are available from
`@topik/core/wiki-navigation` and `@topik/core/course-navigation`.

## Documentation

- [Resources and compilation](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)
- [Project manifest](https://github.com/subtopik/topik/blob/main/docs/resources/manifest.md)
- [Navigation](https://github.com/subtopik/topik/blob/main/docs/resources/navigation.md)
- [Assets](https://github.com/subtopik/topik/blob/main/docs/resources/assets.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT
