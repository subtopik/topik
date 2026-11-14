---
"@topik/cli": patch
---

Print command failures through the public error formatter instead of raw error
messages, and add `topik --version`. `topik validate` now accepts a `topik compile`
output directory, reports which file and resource failed, and skips
`node_modules` and dot-directories while walking. `topik dev` rejects malformed
`--port` values before compiling, reports an occupied port clearly, and shuts down
gracefully on SIGTERM and SIGHUP as well as SIGINT. `topik compile` accepts an
existing empty output directory and publishes directories with mode 0755.
