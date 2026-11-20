---
"@topik/content": patch
"@topik/content-react": patch
"@topik/codemod": patch
---

Add `columns` and `column` for side-by-side layouts, replacing `cardGrid`.

- `{% columns count=3 %}` places its cells side by side. Each cell is a `card`, or a `column` holding any block content, and the two can be mixed. `count` takes 1 to 4 and defaults to 2; more cells flow into further rows, and cells stack on narrow screens. A `column` is allowed only directly inside `columns`; a `card` still stands alone.
- The theme renders `TopikColumns` and `TopikColumn`. Without a themed component, the cells render one after another.
- The Mintlify codemod converts `<CardGroup>` and `<Columns>` to `columns`, and `<Column>` to `column`; `cols` becomes `count`. Content between the cards is wrapped in a `column`, with a note that Mintlify gives each element its own cell.

Breaking:

- `cardGrid` is removed. Write `{% columns count=N %}` where you wrote `{% cardGrid columns=N %}`. A `cardGrid` without `columns` showed three columns; `columns` without `count` shows two.
- `TopikCardGrid` is removed from `@topik/content-react`, and `TopikComponentName` and `TopikComponentMap` gain `TopikColumns` and `TopikColumn`.
- The theme's `.topik-card-grid` class is now `.topik-columns`, and the `--topik-card-grid-columns` custom property is now `--topik-columns-count`. Stylesheets that target the old names need updating.
- The built-in diagnostics for `cardGrid`, `topik-columns-range` and `topik-card-grid-children`, are replaced by `topik-count-range`, `topik-columns-children`, `topik-columns-requires-card` and `topik-columns-parent-required`. A custom component with its own numeric `columns` attribute still reports `topik-columns-range`.
- `column` and `columns` are now canonical components. An application that registered its own `column` or `columns` in `config.components` must rename that schema and the tags that use it together; the built-in schema takes its place.
- `topikComponents.columns` lists no `requiredChildren`, because a card or a column satisfies the minimum.
