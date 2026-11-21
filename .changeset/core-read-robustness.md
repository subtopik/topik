---
"@topik/core": patch
---

Make file reads and asset checks sturdier:

- Reads on Linux no longer fail with `changed-during-read` while Git takes and releases a lock in `.git`, for example when an editor runs `git status` during `compile`, `lint` or `dev`. A `.git` directory is matched by identity, as on other platforms.
- A `.gitattributes` rule that unsets `filter` or `working-tree-encoding` (`-filter`) is accepted, as `git check-attr` reports no effective filter for it.
- Windows device names followed by a space before the extension, such as `CON .txt`, are reserved like `CON.txt`.
- Media sniffing reads at most 64 compatible brands of an `ftyp` box, so a box that claims a whole large file is classified in constant time. An ISO base media file with unknown brands is no longer taken for an icon, an ICO header must list at least one image whose directory fits in the file, and UTF-16LE text that happens to be exactly one MPEG Layer I frame long stays an opaque download.
- Asset materialization checks require `integrity` to start with `sha256:` before comparing it with the blob URI.
- Reading large Wiki, collection and Course configurations takes time proportional to their size: byte ranges are computed in one pass instead of re-encoding the source for every field.
