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
