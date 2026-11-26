# Contributing to Topik

Thanks for helping improve Topik. This guide covers the basics; see
[AGENTS.md](AGENTS.md) for more on the toolchain.

## Setup

This repository is a pnpm workspace that uses the [Vite+](https://viteplus.dev/guide/)
toolchain through its `vp` command. Use the Node.js version in `.node-version`.

```sh
vp install          # install dependencies
vp run -r build     # build every package
vp check            # format, lint, and type check
vp test             # run the test suites
```

Build before you test: packages consume each other's `dist` output, so run
`vp run -r build` after installing and again after changing a package that
others depend on.

`vp run verify:public-packages` packs the public packages and checks them in
clean consumer projects, including browser checks that need Playwright's
Chromium.

### Property tests

`packages/content/src/fuzz.test.ts` generates documents from the component
registry and the Markdown grammar (`src/testing/grammar.ts`). It checks that
formatting round trips and that no document costs more parser work than the
`parserSteps` budget.

`packages/core/src/source/writeback-fuzz.test.ts` generates source projects
(`src/testing/source-projects.ts`) and edits to them. It checks that each edit
plans under its documented authority, keeps the bytes it does not concern, and
plans to no change when repeated.

`vp test` runs both with a fixed seed. To explore new inputs, run `vp run fuzz`.
Each package picks a random seed and runs twenty times as many cases. A run that
fails prints its seed. Set `TOPIK_FUZZ_SEED` to replay a seed and
`TOPIK_FUZZ_RUNS` to choose the count. To explore one package, run `vp run fuzz`
in its directory. fast-check shrinks any failure to a small input: add that input
to a regular test along with the fix.

The write-back properties also require that at least half of the generated
projects compile and initialize, and that most edits plan. A count below a few
hundred can fail those checks by chance.

The Fuzz workflow explores both every week. To replay a run there, start the
workflow with the seed that its log shows.

When you add syntax that the registry does not describe, add it to the grammar.
A new component is generated from its schema without changes.

## Changes

- Keep pull requests focused, and add or update tests for behavior changes.
- Run `vp check` and `vp test` before opening a pull request.
- Add a changeset with `vp run changeset` when a change affects a published
  `@topik/*` package. Repository-only changes (CI, docs, tooling) need none.
- Write commit messages and pull request titles as
  [Conventional Commits](https://www.conventionalcommits.org/), for example
  `fix(core): …` or `chore: …`.

## Writing documentation

The guides in `docs/` and the package READMEs describe what Topik does today.
When a change affects behavior, edit the text so it reads as if Topik had
always worked that way:

- Describe the current behavior in the present tense. Avoid wording that only
  makes sense with history in mind, such as "now", "no longer", "still
  supported" or "instead of the old …". What changed belongs in the changeset.
- Put steps that only matter when upgrading in a "Migrate …" section at the
  end of the page.
- Lead with what the reader does or what happens, then the rules, then the
  edge cases. Prefer a list or table for parallel rules.
- State the rule and its consequence. Explain how the code achieves it only
  when a reader needs that to use Topik correctly.
- Keep exact option names, limits and diagnostic IDs: they are part of the
  contract.

`docs/` is compiled as a Topik wiki by the test suite, so internal links and
anchors must resolve.

## Reporting security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
