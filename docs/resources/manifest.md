# Project manifest

The project manifest, `.topik.yaml`, declares a project's namespace and lists the source configurations to compile. This page covers its fields, how its paths resolve, which files the compiler accepts, and the library functions that read it. Read it when you set up a project or compile one from your own code.

`topik compile`, `topik dev`, and the library's `compile`, `lint`, and `watch` APIs require `.topik.yaml` in the selected project directory:

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

| Field       | Meaning                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `version`   | The manifest syntax version, `1`.                                                                             |
| `namespace` | The [project namespace](#project-namespace). Required.                                                        |
| `sources`   | The configurations to compile. Each entry has exactly `kind` (`wiki`, `collection` or `course`) and `config`. |

The manifest only points to configurations; it holds no content settings:

- Wiki identity, navigation and settings belong in each Wiki configuration, and collection settings in each collection configuration.
- Markdown, frontmatter and ordinary media are the source files.
- Generated JSON resources belong in compiler output.

`version: 1` versions only the manifest syntax. [Source writing](./source-writing.md) describes the source metadata and the project-writing APIs.

A Git checkout is not required. [Inside a Git checkout](#inside-a-git-checkout) describes what applies when there is one.

## Project namespace

`namespace` is required, even for projects without local assets. Choose a stable value such as `example/documentation`. Use the same value across checkouts and copies of one project, and a different value for an independent project. Namespaces are not registered or checked for global uniqueness.

The namespace must be nonblank portable text without leading or trailing whitespace, normalized to Unicode NFC, of at most 1,024 UTF-8 bytes.

Topik combines the namespace with each asset's **manifest-relative path** to generate the asset's identity. Changing the namespace changes every generated asset ID. Changing a Git remote or the checkout location does not. See [Assets](./assets.md#generated-identity) for the exact identity rules.

## Discovery and paths

Run `topik compile ./project`. The compiler loads only the `.topik.yaml` in that exact directory and compiles only the sources it lists:

- A missing manifest produces an error with a minimal example. The compiler does not fall back to discovering conventional configuration files.
- Parent and nested manifests are not searched or loaded.
- `sources: []` compiles an empty project, even if conventional configuration files exist.

### Sources

The declared `kind` selects the configuration schema, regardless of the filename. For example, `config: docs/handbook.yml` selects that exact file and does not read a neighboring `wiki.yaml`. Configurations can be YAML (`.yaml` or `.yml`) or JSON. The schemas of different kinds may overlap; a configuration that is valid under its declared kind is accepted under that kind.

### Path resolution

| Path                         | Relative to                            |
| ---------------------------- | -------------------------------------- |
| A source's `config`          | The directory containing the manifest. |
| Paths inside a configuration | That configuration's directory.        |
| Media references in Markdown | The Markdown document.                 |

The working directory never affects resolution. Paths inside a configuration and media references must also stay within their local containment rules.

A `config` path uses normalized, portable `/` spelling. The compiler rejects absolute paths, URLs, traversal, duplicate declarations, case and Unicode aliases, and unsafe file types. Two sources may share or nest directories.

The location for new media is a setting of each local configuration: see [New media destination](./assets.md#new-media-destination).

### File rules

The manifest and each selected configuration must be a regular, non-executable file, reached without symlinks, with a single hard link and no content filter.

- On Linux the compiler loads these files through descriptor-anchored traversal.
- On macOS and Windows it uses the portable mode described in [Source filesystem safety](./index.md#source-filesystem-safety) by default. With file safety `anchored` (CLI `--file-safety anchored`) the read fails with reason `platform-unsupported`, which the CLI reports as one platform-requirement message.

### Limits and syntax

- The manifest and each selected configuration are limited to 1 MiB.
- A manifest lists at most 1,000 sources.
- Configuration nesting is limited to 32 levels.
- YAML uses core data types. Duplicate keys, aliases and custom tags are rejected.
- Unknown fields, unknown kinds, unsupported versions and missing sources are errors.

### Errors

A configuration failure identifies the zero-based `sources[index]`, the declared kind and the safe manifest-relative config path. The compiler never substitutes a nearby configuration. A failure in a source's own files, such as invalid page frontmatter, reports that file's manifest-relative path and any offending field.

A file that cannot be read fails with the ID `config-read-failed` and a fixed explanation, available as the error's `reason`:

`executable`, `hard-linked`, `symbolic-link`, `special-file`, `too-large`, `git-lfs-pointer`, `git-filtered`, `git-submodule`, `git-evidence-unavailable`, `git-repository-untrusted`, `platform-unsupported` or `changed-during-read`.

The message never includes absolute paths.

#### Classify a failure

Compilation throws three unrelated error classes. `classifyCompileFailure(error)` answers who has to act, without `instanceof` checks:

```ts
import { classifyCompileFailure, compileManifest } from "@topik/core";

try {
  await compileManifest({ dir: projectRoot });
} catch (error) {
  const failure = classifyCompileFailure(error);
  // { kind: "asset", reason: "git-lfs-pointer" }
}
```

| `kind`          | Meaning                                                                                                                                      | Thrown as                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `configuration` | The manifest or a source configuration is missing or invalid.                                                                                | `PublicCompileError`                             |
| `content`       | A document the project reads is missing, misnamed or invalid.                                                                                | `CompileError`, `PublicCompileError`             |
| `asset`         | A local image or download that a document references was refused.                                                                            | `AssetCompilationError`                          |
| `environment`   | The platform, the Git installation or a file that changed during the read prevented a safe read. Another machine or a retry can succeed.     | Either class, with one of the four reasons below |
| `tool`          | The compiler or the calling program failed (`manifest-source-failed`, `reference-targets-invalid`). The author cannot fix it in the project. | `PublicCompileError`                             |
| `unknown`       | The value is not an error the compiler raises.                                                                                               | Anything else                                    |

The result also carries the `id` and `location` of a `PublicCompileError`, and the `reason` of a refused file read when one is known. The reasons `platform-unsupported`, `git-evidence-unavailable`, `git-repository-untrusted` and `changed-during-read` make the kind `environment`; every other reason describes the author's own file and leaves the kind as it is.

An `AssetCompilationError` raised for a compiler invariant, such as an invalid name from a custom name generator, is also reported as `asset`.

### Inside a Git checkout

A checkout is optional. When the project directory or any ancestor contains a `.git` entry, the compiler asks Git to prove that each manifest, configuration and local asset file is a plain worktree file. That places requirements on Git, on the repository and on the files.

Git must be installed in one of these fixed locations. `PATH` is not searched. If Git is not found there, reads fail with `git-evidence-unavailable`.

| Platform | Accepted locations                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Linux    | `/usr/bin/git`, `/bin/git`, `/usr/local/bin/git`, `/run/current-system/sw/bin/git` or `/nix/var/nix/profiles/default/bin/git` |
| macOS    | `/usr/bin/git`, `/opt/homebrew/bin/git`, `/usr/local/bin/git` or `/opt/local/bin/git`                                         |
| Windows  | Git for Windows at `C:\Program Files\Git\cmd\git.exe` or `C:\Program Files\Git\bin\git.exe`                                   |

The Git executable:

- On Linux and macOS it must be owned by root or the current user and must not be group- or world-writable. Windows has no POSIX owner or mode bits, so only the administrator-owned location establishes trust there.
- API callers can name another Git with the `gitExecutable` option of `compile()`, `lint()`, `watch()` and `readPortableAssetFile()`. The value is an absolute path, used instead of the fixed locations; a relative or malformed value throws a `TypeError`. The file must pass the same owner and mode checks, which run again before each Git command, or reads fail with `git-evidence-unavailable`. On Windows these checks cannot apply, so the caller must pick a location that only administrators can write to. The value is never read from project files or the environment, and it is consulted only inside a checkout.
- Inherited variables that redirect Git, such as `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE`, are removed for these checks. `GIT_CONFIG_GLOBAL` and similar configuration variables apply.
- Each Git command is limited to 30 seconds. The compiler queries the repository once per compilation and then runs one `git check-attr` per file read.

The repository:

- Git must accept the repository. A checkout owned by another user, common in containers and CI, fails with `git-repository-untrusted` until you compile as its owner or add it to Git's `safe.directory` setting.
- An ancestor `.git` directory that Git does not recognize as a repository is ignored, as Git ignores it.
- The repository's `core.fsmonitor` setting is turned off for these checks, so its configuration cannot run a command while the compiler reads the index.

The files:

- A file must have no effective `filter` (including Git LFS) or `working-tree-encoding` attribute, as reported by `git check-attr`. Unrelated `.gitattributes` rules, such as `design/**/*.psd filter=lfs`, do not affect other files.
- A file must not be inside a submodule or nested worktree.
- The [file rules](#file-rules) apply as well: a regular, non-executable file with a single hard link, reached without symbolic links below the project directory. On Windows, where there are no executable bits, the executable rule does not apply. Symbolic links above the project directory, such as `/home` linking to `/var/home`, are allowed.

Outside a checkout, the compiler evaluates the project's `.gitattributes` files itself. A rule whose pattern it cannot evaluate exactly (bracket expressions, escapes or macros) fails only for files it could match.

## Library usage

```ts
import { compile, compileManifest, loadTopikManifest } from "@topik/core";

const result = await compile({ dir: projectRoot });
const manifest = await loadTopikManifest(projectRoot);
const project = await compileManifest({ dir: projectRoot });
```

| Export                                                                                                           | Purpose                                            |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `topikManifestSchema`, `topikManifestSourceSchema`, `parseTopikManifest`, `TopikManifest`, `TopikManifestSource` | The public manifest contract.                      |
| `discoverManifestSources`                                                                                        | Loads the declaration descriptors.                 |
| `compileManifest`                                                                                                | Compiles the project and returns its `provenance`. |

`provenance` lists the sources in declaration order. Each entry has the kind, config path, local directory, project namespace, resolved new-media destination, and the authored resource keys mapped to manifest-relative source paths.

`assetSourcePaths` maps each generated local Asset name to the manifest-relative path of its source file. See [Find an asset's source file](./assets.md#find-an-assets-source-file).

### Compile one source without a manifest

`compileWiki`, `compileGuides` and `compileCourse` compile a single source. They do not read or require a manifest:

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

- `configFile` is optional. Without it, they discover the conventional configuration file of the single source, such as `wiki.yaml`, `wiki.yml` or `wiki.json`, and read it with the same rules as a selected configuration.
- `fileSafety` and `gitExecutable` work as they do for `compile`.
- `assets.generateName` receives the resolved absolute asset path and owns the naming policy. It is required only when the compiler discovers local assets.
- `createProjectAssetNameGenerator` uses the explicit project root and namespace to produce the same IDs as a manifest build with those values, including for nested configurations. You can supply your own callback in its place.
- With any callback, the compiler validates files, checks name collisions, emits payloads, and rewrites references.

See [Standalone asset naming](./assets.md#standalone-asset-naming).

## Assets and output

All declared sources share one asset compilation pass, which uses the manifest namespace and manifest-relative paths:

| Situation                                                      | Asset identity                                   |
| -------------------------------------------------------------- | ------------------------------------------------ |
| One file referenced from overlapping sources                   | One identity.                                    |
| Different paths                                                | Different identities.                            |
| Identical bytes at different paths                             | Different identities; the bytes are stored once. |
| Sources reordered, or a configuration renamed in its directory | IDs preserved.                                   |
| An asset moved                                                 | Its ID changes.                                  |

Compilation rejects conflicting authored resource identities and paths, then validates the complete semantic and materialization inventories. The CLI stages one complete output generation. A failed manifest, source or validation leaves prior successful output unchanged. Compilation never writes authoring files.
