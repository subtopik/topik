---
"@topik/core": patch
---

Reduce false positives when reading assets and configuration. Git LFS pointer detection now matches
only the pointer shape (a small file whose first line is a Git LFS `version` line), so files that
merely mention `git-lfs` are readable. Media sniffing validates MP3 frame headers, BMP header
fields, and ISO base media brands (HEIC/HEIF, AVIF, M4A, QuickTime, 3GPP, MP4), and treats text as
HTML only when it starts with a tag or contains an active element, event handler, or `javascript:`
URL. Unsafe filesystem file rejections now name the specific condition.
