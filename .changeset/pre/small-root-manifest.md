---
"@topik/core": minor
"@topik/cli": minor
---

Require `.topik.yaml` with `version`, a stable project `namespace`, and explicit Wiki/collection source pointers for project compilation, linting, watching, and CLI development. Standalone Wiki and collection library operations compile without a manifest.

Generate Asset IDs from the manifest namespace and manifest-relative file path in one project-wide asset pass. Overlapping sources share the same file identity, equal payload bytes deduplicate, and local source containment remains enforced. Namespace or identity-path changes require rebuilding and transferring a complete output generation.

Support local `assets.directory` in Wiki and collection configurations, defaulting to `_assets`, and expose the manifest-relative destination in provenance for future source synchronization. Document media destinations on the assets page.

Accept an `assets.generateName` callback for standalone asset naming. Export `createProjectAssetNameGenerator` for the standard project-root-relative policy. The public naming API uses `projectNamespace` and `manifestRelativePath`, with `validateProjectNamespace` for validation. Astro loaders accept the same callback and a stable loader `name` for snapshot sharing; the loader name does not affect asset identity.
