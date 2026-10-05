---
"@topik/core": minor
"@topik/cli": minor
---

Require `.topik.yaml` with `version`, a stable project `namespace`, and explicit Wiki/collection source pointers for project compilation, linting, watching, and CLI development. This is a breaking change: migrate implicit source discovery and CLI/library namespace options into the manifest. Explicit standalone Wiki and collection library operations remain available.

Generate Asset IDs from the manifest namespace and manifest-relative file path in one project-wide asset pass. Overlapping sources share the same file identity, equal payload bytes deduplicate, and local source containment remains enforced. Namespace or identity-path changes require rebuilding and transferring a complete output generation.

Support local `assets.directory` in Wiki and collection configurations, defaulting to `_assets`, and expose the manifest-relative destination in provenance for future source synchronization. Document media destinations on the assets page.
