---
"@topik/cli": patch
---

- `topik lint --json` prints its JSON report on stdout when the project cannot be loaded, for example when `.topik.yaml` is missing or a configured page does not exist. The report holds one error diagnostic with the failure's ID and message, and the exit status is unchanged.
- The README lists which files `topik format` leaves untouched, and the bundled docs say that `topik init` also writes `AGENTS.md`.
