---
title: Links and plain URLs
description: Declare link intent, validate destinations, and preserve references when editing.
---

# Links and plain URLs

Topik creates links only from explicit Markdown syntax. A URL or email address
written as ordinary text stays text through parsing, formatting, and rendering.
This page is for authors who write links and for integrations that import, edit
or export Topik Markdown.

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
autolinks and does not infer links from plain addresses. An address inside code
is literal.

A plain address is ordinary text, so Markdown syntax inside it applies:
`https://example.com/a*b*c` contains an emphasized `b`. Write
`<https://example.com/a*b*c>` or `[Example](https://example.com/a*b*c)` to make
the complete address a destination.

Formatting keeps the form the author chose:

- `<https://example.com>` stays an autolink.
- `[https://example.com](https://example.com)` stays a link with a label.
- A link whose label was edited, or a link in a tree built without parser
  positions, is written as `[label](destination)`.

## Destination admission

A link destination can be a credential-free HTTPS URL, a `mailto:` or `tel:`
address, a local page path, or a heading fragment.

Link syntax and destination validity are separate checks. Parsing keeps the
complete destination, whatever it is. `validateTopikContent` and
`compileTopikContent` apply the URL policy before publishing or rendering.

Two checks apply:

| Check                             | Applies to                                                                 | Refuses                                                          |
| --------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Link policy (`validateTopikHref`) | Link destinations                                                          | Script URLs, protocol-relative URLs, and credential-bearing URLs |
| Asset reference check             | Every Markdown link, autolink, reference definition, and image destination | External URLs that are not credential-free HTTPS                 |

The link policy alone does not refuse `http:` URLs. The asset reference check
does, so source admission refuses an `http:` destination with
`TOPIK_EXTERNAL_REFERENCE_UNSAFE`, not with a link policy error. The plain text
`http://example.com` is valid, because it is not a destination.

Images and downloadable files also follow the [asset rules](../resources/assets.md).
Authors use local paths or HTTPS.

The `asset:` scheme is reserved for compiler-generated resources:

- Source admission refuses it unless `allowCompiledAssetReferences` is enabled.
- Reader compilation accepts canonical compiled references.
- The renderer resolves them through the application's asset resolver.

The wiki compiler also checks internal page targets and heading fragments. See
[Navigation](../resources/navigation.md#links-between-pages) for
source-relative links and route resolution.

## Reference links

```markdown
Read the [installation guide][setup].

[setup]: https://example.com/setup
```

A reference link names a label, and a definition elsewhere supplies the
destination. A definition may follow the references that use it.

Scopes decide which definition a reference uses:

- Lists, blockquotes, and ordinary components share the document's scope.
- Each conditional branch is a separate scope.
- A reference looks in its own branch, then in enclosing branches, then in the
  document. It cannot see definitions in sibling or descendant branches.
- The first definition of a label in a scope wins, even if it follows the
  reference.

Put a definition outside a conditional when both branches should share it.

Formatting keeps authored references and their bindings. Evaluation resolves
each reference before it removes branches, and writes inline destinations in the
derived document.

A reference without a definition is literal text in Markdown source. A reference
node that an application constructs with no matching definition is refused.

## Editing and synchronization

An editor or synchronization integration must keep the author's distinction
between text and links:

- An editor can turn a pasted address into a link, but it must export that
  decision as explicit Markdown syntax.
- Importing Markdown must preserve which addresses are text and which are links.
- Removing a link must leave text that stays unlinked after export and import.

A stable parse/write/parse cycle proves preservation. It does not prove that the
first parse interpreted the author's intent correctly, so an integration should
also check whether the imported node is text, an inline link, or a reference
link. See [Content format](./content-design.md#validate-and-format-source) for
formatting and failure handling.
