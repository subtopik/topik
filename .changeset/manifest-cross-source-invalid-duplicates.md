---
"@topik/core": patch
---

Detect a resource identity shared by two manifest sources when one of the documents has invalid content. A page or guide whose body fails validation now still claims its ID across sources, so the project fails with `manifest-resource-conflict` instead of reporting only the content error and surfacing the conflict on a later run.
