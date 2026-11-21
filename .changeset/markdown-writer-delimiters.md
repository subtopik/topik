---
"@topik/content": patch
---

Keep emphasis delimiters readable with mdast-util-to-markdown 2.2.3. That release swaps an emphasis delimiter that touches its parent's delimiter and then writes the neighbouring letters as character references, so formatting `**a*b***` produced `**&#x61;_&#x62;_**`. The writer now keeps the delimiters it chose, and targeted rewrites fall back to the Markdown writer's choice only when the chosen delimiters would change how authored marks nest.
