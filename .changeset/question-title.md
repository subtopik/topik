---
"@topik/content": patch
"@topik/content-react": patch
---

- A `question` takes an optional `title`: the question the reader answers. It accepts a text template (`title=t"…"`), like other titles.
- The default theme shows the title as the legend of the question's choices, so assistive technology names the choices by it, and keeps the "Choose one answer" instruction as their description. The plain renderer shows the title as a paragraph before the choices.
