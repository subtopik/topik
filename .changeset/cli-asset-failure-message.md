---
"@topik/cli": patch
"@topik/core": patch
---

`topik compile`, `topik lint` and `topik dev` say which image or download failed and why, where they printed only "Topik command failed." A file that holds a Git LFS pointer reads "pic.png: An image or download could not be read. The file is a Git LFS pointer; run git lfs pull to fetch its content."; a failure without a known cause names the file and the diagnostic ID. `@topik/core` exports `publicCompileReasonMessage` for the fixed explanation of a read-failure reason.
