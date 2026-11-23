---
"@topik/codemod": patch
---

Add `--diff` to `topik-codemod mintlify`, printing a unified diff of the migration
without writing files. The command also accepts a single `.md` or `.mdx` file, and
converts a Mintlify `docs.json` or legacy `mint.json` navigation into a new
`wiki.yaml` (never replacing an existing wiki configuration), reporting entries
without a direct Topik equivalent as warnings.
