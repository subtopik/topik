---
"@topik/core": patch
"@topik/cli": patch
---

Run `topik compile`, `topik lint` and `topik dev` on macOS and Windows. Where
descriptor-anchored traversal is unavailable, the manifest, configuration and asset
reader now has a portable mode like the Markdown reader's: no links at or below the
source directory, the opened handle must be the inspected file, the resolved path
must equal the lexical one, and everything is inspected again after the read. Git
evidence, `.gitattributes`, size and hard-link checks are kept; Windows drops the
executable-bit and sparse-file checks, which its file metadata cannot support.
Output is published by staging a sibling directory and renaming it into place.
The new `fileSafety` option (`compile`, `lint`, `watch`, default
`DEFAULT_FILE_SAFETY = "portable"`) and CLI flag `--file-safety anchored` refuse
the weaker mode; off Linux that stops with one message naming the Linux
requirement. In portable mode the CLI prints one notice per run. Linux behaviour
is unchanged.
