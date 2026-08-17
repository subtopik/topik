---
title: Alpha releases
---

# Alpha release operations

Topik publishes its six public packages as one versioned cohort. The machine-readable plan in
`release/alpha-plan.json` is authoritative for the package set, compatibility facts, immutable Git
tag, candidate tag, and adoption lane. `@topik/astro` is private and is never part of this process.

## Prepare and publish a candidate

1. Update the release plan and all public package versions together. Run the frozen install, build,
   checks, tests, and `pnpm run release:validate`.
2. Create the exact `v<version>` tag named by the plan only after the release commit is final. Pushing
   that tag starts initial publication. Do not start a release from a moving branch.
3. The publication workflow verifies that the tag dereferences to its checkout and that no planned
   package version exists. It builds each tarball once, verifies the complete packed cohort in a
   temporary consumer, then publishes every package publicly under `candidate` with npm
   provenance. It does not move `alpha`.
4. Validate the exact candidate version in the required private/manual consumer. Record that evidence
   in the private operational system, not in this public repository.
5. Run **Promote alpha cohort** with the same immutable tag and explicitly confirm that the private
   consumer gate completed. Promotion rebuilds from that tag, matches every registry integrity and
   provenance record, and requires all `candidate` tags to agree before changing `alpha`.

Promotion is deliberately fail-closed. It removes every old `alpha` tag before adding the new ones.
The lane can therefore be temporarily unavailable, but it cannot be left pointing at a mixture of
old and new versions by the normal workflow. A failed promotion is retried with the same tag; the
tooling continues forward and removes `candidate` only after all `alpha` tags agree.

## Recover a partial candidate publication

Run **Publish candidate cohort** manually and supply the original immutable tag. Manual dispatch is
recovery-only. It checks out and rebuilds from that tag, compares the rebuilt SHA-512 integrity with
every version already present, and aborts on any mismatch before publishing a missing package. It
then verifies public access, exact metadata, provenance, integrity, and candidate-tag agreement for
the complete cohort.

Never create a replacement tag or change source to recover an existing npm version. Published bytes
are immutable. If local and registry integrity disagree, stop and investigate instead of skipping or
republishing the package.

Both workflows share one non-cancelling concurrency group. They also remove `latest` whenever it
points to a prerelease and never assign an alpha to `latest`. These controls serialize ordinary
workflow operations and detect registry state at each gate; they do not prevent a privileged npm
owner from mutating tags outside the workflows.
