# Project manifest

Every project compiled with `topik compile`, `topik dev`, or the library's `compile`, `lint`, and `watch` APIs requires `.topik.yaml` in the selected project directory:

```yaml
version: 1
namespace: example/documentation
sources:
  - kind: wiki
    config: docs/wiki.yaml
  - kind: collection
    config: guides/collection.yaml
  - kind: wiki
    config: handbook/reference/wiki.yaml
```

The manifest declares the project namespace and points to existing configurations. Wiki identity, navigation and settings stay in each Wiki configuration; collection settings stay in each collection configuration. Markdown, frontmatter and ordinary media remain the source files. Generated JSON resources belong in compiler output. A Git checkout is not required.

`version: 1` versions only manifest syntax. It does not change content grammar or resource schemas. Version 1 supports `wiki` and `collection`; Course compilation, project initialization, publishing and source write-back are outside this feature.

## Project namespace

`namespace` is required, even for projects without local assets. Choose a stable value such as `example/documentation`. Use the same value across checkouts and copies of one project; choose a different value for an independent project. Namespaces are not registered or checked for global uniqueness.

The namespace is nonblank portable text, normalized to Unicode NFC, with a maximum of 1,024 UTF-8 bytes. Topik uses it together with each asset's **manifest-relative path** to generate the asset's identity. Changing the namespace changes every generated asset ID. Changing a Git remote or checkout location does not. See [Assets](./assets.md#generated-identity) for the exact identity rules.

Project compilation uses the namespace declared in the manifest.

## Discovery and paths

Run `topik compile ./project`. Only `.topik.yaml` in that exact directory is loaded. A missing manifest produces an error with a minimal example; there is no conventional-discovery fallback. Parent and nested manifests are not searched or recursively loaded. Only listed sources are compiled. `sources: []` explicitly compiles an empty project, even if conventional configuration files exist.

Each source contains exactly `kind` and `config`. The declared kind selects the existing local schema, regardless of filename. For example, `config: docs/handbook.yml` selects that exact file without reading a neighboring `wiki.yaml`. YAML, YML and JSON configurations are supported. Local schemas may overlap; a configuration valid under the declared kind is accepted under that kind.

Configuration paths use normalized, portable, manifest-relative `/` spelling. Absolute paths, URLs, traversal, duplicate declarations, case/Unicode aliases and unsafe file types are rejected. Directory overlap is allowed. Files must satisfy the existing portable file rules: regular non-executable files without symlinks, hardlinks or content filters. Safe file loading currently requires Linux descriptor-anchored traversal.

Paths inside each configuration remain relative to that configuration's directory; Markdown media references remain relative to their document. Both retain their existing local containment rules. Changing the working directory does not change resolution. The location for new media is a local configuration setting: see [New media destination](./assets.md#new-media-destination).

The manifest and explicitly selected configurations are limited to 1 MiB each, with at most 1,000 sources and 32 levels of configuration nesting. YAML uses core data types; duplicate keys, aliases and custom tags are rejected. Unknown fields and kinds, unsupported versions and missing sources fail visibly. Config failures identify the zero-based `sources[index]`, declared kind and safe manifest-relative config path. No nearby config is substituted.

## Library usage

```ts
import { compile, compileManifest, loadTopikManifest } from "@topik/core";

const result = await compile({ dir: projectRoot });
const manifest = await loadTopikManifest(projectRoot);
const project = await compileManifest({ dir: projectRoot });
```

`topikManifestSchema`, `topikManifestSourceSchema`, `parseTopikManifest`, `TopikManifest` and `TopikManifestSource` expose the public contract. `discoverManifestSources` loads declaration descriptors. `compileManifest` returns `provenance` in declaration order: kind, config path, local directory, project namespace, resolved new-media destination, and authored resource keys mapped to manifest-relative source paths.

Single-source library operations compile without a manifest:

```ts
import { compileWiki, createProjectAssetNameGenerator } from "@topik/core";

const wiki = await compileWiki({
  dir: projectRoot,
  configFile: "docs/handbook.yml",
  assets: {
    generateName: createProjectAssetNameGenerator({
      projectRoot,
      projectNamespace: "example/documentation",
    }),
  },
});
```

`compileGuides` accepts the same optional `configFile` selector. Omitting it uses conventional single-source discovery. These operations do not read or require a manifest. Their `assets.generateName` callback receives the resolved absolute asset path; it owns the naming policy. The helper above uses the explicit project root and namespace to produce the same IDs as a manifest build with those values, including for nested configurations. Custom callbacks are also supported. The compiler still validates files, checks name collisions, emits payloads, and rewrites references. A callback is required only when local assets are discovered. See [Standalone asset naming](./assets.md#standalone-asset-naming).

## Assets and output

All declared sources use one asset compilation pass with the manifest namespace and manifest-relative paths. The same file has one asset identity even when referenced from overlapping sources. Different paths have different identities; identical payload bytes are stored once. Reordering sources or renaming a configuration within its directory preserves asset IDs. Moving an asset changes its ID.

Compilation rejects conflicting authored resource identities and paths, then validates the complete semantic and materialization inventories. The CLI stages one complete output generation. A failed manifest, source or validation leaves prior successful output unchanged. Compilation never writes authoring files.
