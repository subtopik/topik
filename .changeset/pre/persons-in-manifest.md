---
"@topik/core": patch
---

Persons are declared once in the project manifest, `.topik.yaml`, under `persons`, and every source's Guide, Course and Course page authors refer to them. Breaking: a collection or Course configuration that still declares `persons` is refused with `config-invalid` naming the field; move its records to the manifest. `compileGuides` and `compileCourse` do not read the manifest, so they take the Persons as a `persons` option and include them in the result.

Source write-back follows: a Person's provenance names `.topik.yaml` with `kind: "manifest"`, and a Person create names `.topik.yaml` as its `config`. In the manifest a plan edits only `persons`. Initialization writes the Persons into the new manifest; adding a source reuses a Person the manifest already declares, appends a new one, and refuses one declared differently with the new `person-conflict` diagnostic. An absent field's insertion anchor now admits adding that key. The provenance version is now `8`, so saved projects and plans must be reinspected.
