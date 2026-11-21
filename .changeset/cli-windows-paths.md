---
"@topik/cli": patch
---

`topik init` rolls back only the directories it created when Windows reports a created path under another spelling (short and long names); it could previously remove an empty parent directory that already existed. `topik compile` now refuses an output path beneath a file as a collision on every platform, instead of reporting that the path could not be resolved.
