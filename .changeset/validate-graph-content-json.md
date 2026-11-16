---
"@topik/cli": patch
"@topik/core": patch
---

Add opt-in `topik validate --graph` (unique `type/name` and resolvable by-name
references across the loaded set) and `--content` (Topik content checks for
CoursePage, Guide and WikiPage), and `--json` for a stable machine-readable report
on stdout. Core exports the matching `validateResourceGraph` and
`validateResourceContent`. Default output and exit codes are unchanged.
