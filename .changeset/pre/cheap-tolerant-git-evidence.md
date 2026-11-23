---
"@topik/core": patch
"@topik/cli": patch
---

Make Git evidence for manifest, configuration and asset reads cheap and tolerant.
Repository discovery and the index are read once per compilation instead of
several Git processes per file, and generic-link probes are cached by path, so a
checkout no longer multiplies compile time by the number of links. Git is found in
a fixed list of trusted absolute locations, runs with a timeout and without
inherited repository-redirecting `GIT_*` variables, and an ancestor `.git` that Git
does not recognize is ignored. Inside a worktree `git check-attr` decides each
path; outside one, an unrelated `.gitattributes` rule such as
`design/**/*.psd filter=lfs` no longer fails every read. `config-read-failed`
errors now carry a sanitized `reason` (for example `executable`, `hard-linked`,
`symbolic-link`, `git-repository-untrusted` or `git-evidence-unavailable`), a
fixed explanation in the message that the CLI prints, and the reader diagnostics
as `cause`. Markdown reads accept symlinked ancestors above the source directory
like the configuration reader, dangling guide symlinks become located
`guide-not-regular-file` diagnostics, and extensionless page links compile on
platforms without descriptor-anchored reads.
