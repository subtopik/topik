---
"@topik/core": patch
---

Check same-page card fragments on course pages. A card with a fragment-only `href` such as `#setup` names its own page, but on course pages the compiler skipped it, so a missing section went unreported and `link-fragment-positional` never fired. Such cards are now checked like same-page links, reporting `link-fragment-not-found` and `link-fragment-positional`. Course page cards to destinations the compiler cannot resolve, such as application routes, are still not checked.
