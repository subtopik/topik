# @topik/core

Compile directories of Topik Markdown into typed resources. `@topik/core`
compiles wikis, guide collections, and courses declared in a project manifest,
generates asset resources for local images and downloads, validates resource
envelopes, and resolves wiki and course navigation.

To render a single document, use
[`@topik/content`](https://github.com/subtopik/topik/tree/main/packages/content)
or [`@topik/content-react`](https://github.com/subtopik/topik/tree/main/packages/content-react).

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

The result also contains asset payloads, diagnostics, and compilation
inventories.

To compile other sources:

- `compile` compiles every source declared in `.topik.yaml`.
- `compileGuides` compiles a standalone guide collection.
- `compileCourse` compiles a standalone course.

## Entry points

| Entry point                     | Provides                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@topik/core`                   | Compilers, manifest parsing, asset naming, source-project update planning, and `validateResources`. |
| `@topik/core/wiki-navigation`   | Wiki navigation and link resolution helpers.                                                        |
| `@topik/core/course-navigation` | Course navigation and link resolution helpers.                                                      |
| `@topik/core/preview`           | Browser-safe local preview types, including `PreviewState`.                                         |

The wiki link resolution contract is in the
[navigation guide](https://github.com/subtopik/topik/blob/main/docs/resources/navigation.md#wiki-resolver-contract).

## Documentation

- [Resources and compilation](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)
- [Project manifest](https://github.com/subtopik/topik/blob/main/docs/resources/manifest.md)
- [Navigation](https://github.com/subtopik/topik/blob/main/docs/resources/navigation.md)
- [Source writing](https://github.com/subtopik/topik/blob/main/docs/resources/source-writing.md)
- [Assets](https://github.com/subtopik/topik/blob/main/docs/resources/assets.md)
- [Local preview protocol](https://github.com/subtopik/topik/blob/main/docs/preview-protocol.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT
