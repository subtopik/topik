---
"@topik/cli": patch
---

- `topik lint --json` prints its JSON report on stdout when `.topik.yaml` cannot be loaded. The report holds one error diagnostic with the failure's ID, such as `manifest-required`, and its message, and the exit status is unchanged.
- The README lists which files `topik format` leaves untouched, and the bundled docs say that `topik init` also writes `AGENTS.md`.
