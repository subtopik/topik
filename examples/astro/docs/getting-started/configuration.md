---
title: Configuration
---

# Configuration

Topik content is configured through YAML files that live alongside your markdown.

## Wiki Configuration

Create a `wiki.yaml` file to define your documentation structure:

```yaml
id: docs
title: Documentation
navigation:
  - introduction
  - group: Getting Started
    children:
      - getting-started/installation
      - getting-started/configuration
```

## Guide Collections

Create a `collection.yaml` to define a guide collection:

```yaml
id: blog
title: Blog
tags:
  - engineering
```
