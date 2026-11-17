---
"@topik/core": patch
---

Give compile callers three things they had to work out themselves. Every compile result has `assetSourcePaths`, a map from each generated local Asset name to the source file's path relative to the compilation directory; it is caller-side provenance and is not written to `semantic.json`, `materialization.json`, the output directory or the preview. `classifyCompileFailure(error)` sorts anything a compile function throws into `configuration`, `content`, `asset`, `environment`, `tool` or `unknown`, with the public error ID, location and read-failure reason when present, so a caller no longer needs `instanceof` checks on `PublicCompileError`, `CompileError` and `AssetCompilationError`. `AssetCompilationError` has a stable `reason` when a local file was refused for a known cause, so an image that is a Git LFS pointer (`git-lfs-pointer`) can be told apart from a damaged one.

`AssetCompilationResult` gains the required `assetSourcePaths` field: code that builds such a result itself, in place of taking it from a compile function, must add it.
