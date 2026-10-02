---
title: Links and plain URLs
description: Declare link intent, validate destinations, and preserve references when editing.
---

# Links and plain URLs

Topik creates links only from explicit Markdown syntax. A URL or email address
written as ordinary text stays text through parsing, formatting, and rendering.

## Choose the link syntax

| Source                                           | Result                                 |
| ------------------------------------------------ | -------------------------------------- |
| `https://example.com`                            | Plain text.                            |
| `www.example.com`                                | Plain text.                            |
| `person@example.com`                             | Plain text.                            |
| `mailto:person@example.com`                      | Plain text.                            |
| `[Example](https://example.com)`                 | A link with a label.                   |
| `<https://example.com>`                          | A link whose label is the URL.         |
| `<person@example.com>`                           | A link to `mailto:person@example.com`. |
| `[Example][site]` and a `[site]: ...` definition | A reference link.                      |

Angle-bracket links are CommonMark autolinks. Topik does not enable GFM literal
autolinks or infer links from plain addresses. Code remains literal.

Markdown still applies to plain text: `https://example.com/a*b*c` contains
emphasized `b`. Write `<https://example.com/a*b*c>` or
`[Example](https://example.com/a*b*c)` to make the complete address a destination.

## Destination admission

Link syntax and destination validity are separate checks. Parsing retains the
complete destination; `validateTopikContent` and `compileTopikContent` apply the
URL policy before publishing or rendering.

Ordinary content links support credential-free HTTPS, `mailto:`, `tel:`, local
page paths, and heading fragments. Script URLs, protocol-relative URLs, and
credential-bearing URLs are refused. HTTP is refused for Markdown link
and asset destinations; the text `http://example.com` is still valid plain text.

Images and downloadable files also follow the [asset rules](../resources/assets.md).
Authors use local paths or HTTPS. The reserved `asset:` scheme identifies
compiler-generated resources: normal source admission refuses it unless
`allowCompiledAssetReferences` is enabled. Reader compilation accepts canonical
compiled references and the renderer resolves them through the application's
asset resolver.

The wiki compiler additionally checks internal page targets and heading
fragments. See [Navigation](../resources/navigation.md#links-between-pages) for
source-relative links and route resolution.

## Reference links

```markdown
Read the [installation guide][setup].

[setup]: https://example.com/setup
```

The first definition of a label in a scope wins, even if it follows the reference.
Lists, blockquotes, and ordinary components share the document's reference scope.
Each conditional branch introduces a separate scope.

A reference looks in its own branch, then enclosing branches, then the document.
Definitions in sibling or descendant branches are invisible. Put a definition
outside a conditional when both branches should share it.

Formatting retains authored references and their bindings. Evaluation resolves
references before removing branches and emits inline destinations in the derived
document. A missing Markdown definition normally leaves literal text; manually
constructed reference nodes with no matching definition are refused.

## Editing and synchronization

An editor can turn a pasted address into a link, but it must export that decision
as explicit Markdown syntax. Importing Markdown must preserve the author's
text/link distinction. Removing a link must leave text that stays unlinked after
export and import.

A stable parse/write/parse cycle proves preservation, but does not prove that the
first parse interpreted the author's intent correctly. Integrations should also
check whether the imported node is text, an inline link, or a reference link.
See [Content format](./content-design.md#validate-and-format-source) for formatting
and failure handling.
