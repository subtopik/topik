---
"@topik/core": patch
"@topik/cli": patch
---

Breaking: a Wiki `theme` rejects keys it does not define. A misspelled or unknown key in `theme`, `theme.colors` or `theme.appearance`, such as `apperance` or `lite`, fails with `config-field-unknown` naming it, such as `theme.apperance`. Previously such keys were silently dropped, so a typo left the theme unchanged without any message. Other unknown top-level configuration keys stay accepted unless they look like a misspelling of a known key.
