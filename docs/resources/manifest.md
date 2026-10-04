# Repository manifest

A repository can contain a small `.topik.yaml` at its root to select multiple Wikis and collections:

```yaml
version: 1
sources:
  - kind: wiki
    config: docs/wiki.yaml
  - kind: collection
    config: guides/collection.yaml
  - kind: wiki
    config: handbook/reference/wiki.yaml
```

The manifest points to existing configurations. Wiki identity, navigation and settings stay in each Wiki configuration; collection settings stay in each collection configuration. Markdown, frontmatter and ordinary media remain the source files. Generated JSON resources belong in compiler output.

`version: 1` versions only manifest syntax. It does not change content grammar or resource schemas. Version 1 supports `wiki` and `collection`; Course compilation, project initialization, publishing and source write-back are outside this feature.

## Discovery and paths

Run `topik compile ./repository`. The caller selects the project root; a Git checkout is not required. Only `.topik.yaml` in that exact directory is considered. When present, only listed sources are compiled. When absent, the existing conventional `wiki.yaml`/`wiki.yml`/`wiki.json` and `collection.yaml`/`collection.yml`/`collection.json` discovery still applies. An invalid manifest fails instead of falling back. Parent and nested manifests are not searched or recursively loaded. `sources: []` explicitly compiles an empty project, even if conventional configuration files exist.

Each source contains exactly `kind` and `config`. The declared kind selects the existing local schema, regardless of filename. For example, `config: docs/handbook.yml` selects that exact file without reading a neighboring `wiki.yaml`. YAML, YML and JSON configurations are supported. Local schemas may overlap; a configuration valid under the declared kind is accepted under that kind.

Configuration paths use normalized, portable, root-relative `/` spelling. Absolute paths, URLs, traversal, duplicate declarations, case/Unicode aliases and unsafe file types are rejected. Directory overlap is allowed. Files must satisfy the existing portable file rules: regular non-executable files without symlinks, hardlinks or content filters. As with portable local Assets, safe file loading currently requires Linux descriptor-anchored traversal.

Paths inside each configuration, including page and media references, remain relative to that configuration's directory and keep their existing containment rules. Changing the working directory does not change this resolution.

The manifest and explicitly selected configurations are limited to 1 MiB each, with at most 1,000 sources and 32 levels of configuration nesting. YAML uses core data types; duplicate keys, aliases and custom tags are rejected. Unknown manifest fields and kinds, unsupported versions and missing sources fail visibly. Config failures identify the zero-based `sources[index]`, declared kind and safe relative config path. No nearby config is substituted.

## Library usage

```ts
import {
  compile,
  compileManifest,
  compileWiki,
  deriveManifestSourceNamespace,
  loadTopikManifest,
} from "@topik/core";

const result = await compile({
  dir: repositoryRoot,
  assets: { sourceNamespace: "my-stable-repository" },
});

// Explicit manifest operations fail if .topik.yaml is absent.
const manifest = await loadTopikManifest(repositoryRoot);
const project = await compileManifest({
  dir: repositoryRoot,
  assets: { sourceNamespace: "my-stable-repository" },
});

// Exact configs can also be compiled independently of any root manifest.
const wiki = await compileWiki({
  dir: repositoryRoot,
  configFile: "docs/handbook.yml",
  assets: {
    sourceNamespace: deriveManifestSourceNamespace("my-stable-repository", "docs"),
  },
});
```

`compileGuides` accepts the same optional `configFile` selector. Omitting it keeps conventional single-source discovery. Explicit single-source calls ignore root or parent manifests. `topikManifestSchema`, `topikManifestSourceSchema`, `parseTopikManifest`, `TopikManifest` and `TopikManifestSource` expose the public contract. `discoverManifestSources` loads declaration descriptors. `compileManifest` returns `provenance` in declaration order: kind, config path, local directory, effective namespace (if supplied), and authored resource keys mapped to root-relative source paths.

## New media destination

Each Wiki or collection configuration can select the destination for new synced media:

```yaml
# docs/wiki.yaml (also supported in collection.yaml)
id: docs
title: Documentation
assets:
  directory: _assets
```

`assets.directory` defaults to `_assets` beside the local configuration. Override it with a normalized portable relative directory, for example `media/uploads`. The path is relative to that configuration's directory, never to the process working directory. Absolute paths, URLs, traversal, case/Unicode-unsafe spelling, and reserved `.git`/`.topik` paths are rejected. The root `.topik.yaml` remains a list of source pointers; it has no asset defaults or inheritance.

This setting chooses where **new** media will be written during source synchronization. It does not move existing media, restrict which local media can be referenced, change Asset namespaces, or relocate compiled `blobs/` output. Compilation neither creates the destination nor writes files there. Source write-back is not implemented by this feature; it must preserve existing paths, use deterministic filenames, and reject destination conflicts without overwriting unrelated files. A destination setting grants no ownership over existing files.

Configurations in the same directory share `_assets` by default, and may each override their destination. Shared directories alone are not conflicts. At write time, the complete resolved destination and filenames must pass the existing containment, file-type and collision checks; an existing file cannot be treated as a directory or overwritten by implication. The directory need not exist when compiling.

The public Wiki/collection parsers return the effective `assets.directory`, including the default. Manifest compilation exposes each source's resolved root-relative `assetDirectory` in its provenance. `sourceAssetsConfigSchema`, `SourceAssetsConfig` and `DEFAULT_ASSET_DIRECTORY` are exported for tools using the same contract.

## Assets and output

For local automatic Assets, pass a stable repository namespace through the existing `--source-namespace` CLI option or `assets.sourceNamespace` library option:

```sh
topik compile ./repository --source-namespace my-stable-repository
```

The CLI retains Git-based namespace derivation when this flag is omitted. If local Assets require a namespace and none can be supplied or derived, compilation fails with the existing actionable namespace error. Projects without local automatic Assets do not require a namespace.

Configurations in one directory share an Asset compilation pass and effective namespace. Different directories receive distinct effective namespaces, even when images have the same local filenames. Identical payload bytes are stored once with all referencing Asset names and occurrence mappings preserved.

`deriveManifestSourceNamespace(repositoryNamespace, directory)` returns `topik-manifest-source-v1:` plus the lowercase SHA-256 of the UTF-8 compact canonical JSON array `[repositoryNamespace, directory]`, with no trailing newline. The repository namespace uses existing NFC normalization; `directory` must be a canonical root-relative path, or `""` for the root. Pass the returned namespace directly to standalone compilation to reproduce the source's manifest output. Reordering sources or renaming a configuration within its directory does not change Asset identity. Moving the directory may change it.

Compilation rejects conflicting authored resource identities and output paths, then rebuilds and validates the complete semantic and materialization inventories. The CLI stages one complete output generation. A failed manifest, source or aggregate validation leaves prior successful output unchanged. Compilation never writes authoring files.
