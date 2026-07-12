---
title: Navigation
---

# Navigation

Wiki navigation is an ordered tree of tabs, dropdowns, groups, pages, and external links.

```text
tabs → dropdowns → groups/pages/links
dropdowns → groups/pages/links
groups → groups/pages/links
```

Tabs may appear only at the root. Dropdowns may appear at the root or directly inside tabs. Sidebar nodes may be mixed, but navigation surfaces at the same level may not be mixed.

An internal container may define a non-empty `slug`. That slug contributes one segment to both the Markdown file path and public route. Omitting `slug` makes the container organizational only. Empty slugs are invalid.

```yaml
- type: tab
  title: Documentation
  slug: docs
  children:
    - type: dropdown
      title: Guides
      children:
        - type: group
          title: Setup
          slug: setup
          children:
            - installation
```

This page is read from `docs/setup/installation.md` and has the route `/docs/setup/installation`. A page named `index.md` maps to its containing route. Every compiled page must have one canonical navigation position and every final route must be unique.

External tabs and dropdowns use `href` instead of `children`. Ordinary external sidebar destinations use a `link` node.
