---
"@topik/core": minor
"@topik/content": minor
"@topik/content-react": minor
---

Compile resolved WikiPage and Guide document links to portable
`ref://wiki-page/<resource.name>` and `ref://guide/<resource.name>` URIs. Admit
direct authored references, preserve queries and heading fragments, validate
locally known targets and optional application-provided inventories, and record
verified, deferred, or invalid reference states without fetching remote targets.

This changes compiled content destinations: applications must supply browser URL
resolution before publishing newly compiled resources. React resolves references
before custom components and framework adapters, reports generic diagnostics,
and omits unresolved or unsafe browser hrefs. Astro keeps portable loader bodies
and provides `createTopikLinkResolver` using entry names and caller-defined routes.
Asset reference semantics remain unchanged.

Retain legacy relative-link support in the wiki route resolver. Preserve original
authored links and source context for reviewed writes, advancing source reference
provenance to `source-links-v3` and version `5`. Regenerate source snapshots and
update plans from authored source before migrating compiled content.
