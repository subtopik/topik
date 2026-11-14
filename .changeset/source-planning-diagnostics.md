---
"@topik/core": patch
---

Fix source planning edge cases: create nested scratch directories on Windows,
let initialization ignore YAML/JSON files that cannot be Topik configuration
(such as commented `tsconfig.json`, anchored compose files or large lockfiles)
while naming any blocking file, report `source-creation-required` for a new Wiki,
`source-version-collision` for opaque legacy frontmatter on opt-in,
`source-base-changed` for a stale source-addition base and `source-tree-invalid`
for tree limit failures, order initialized changes bytewise, and keep the
original exception as a non-enumerable `cause` on generic fallback diagnostics.
