# Changesets

Add a changeset for every publishable change with `pnpm changeset`. The six public packages are a
fixed group, so changing one versions the complete cohort; the private Astro package is excluded.

For an alpha release, run `pnpm changeset version`, review the version and packed manifests, then
push a `v*` tag or manually dispatch the Publish workflow. Do not run `changeset publish`: it
selects `latest` for these prerelease-only packages, while `changeset publish --tag alpha` is
rejected in prerelease mode. The workflow is the supported path and always uses the `alpha` tag.

The workflow uses Changesets to select and pack unpublished versions, then publishes those tarballs
with npm's trusted-publishing CLI. Configure every public package on npm with repository
`subtopik/topik`, workflow filename `publish.yaml`, and environment `npm`; no publish token is used.

Publishing is intentionally non-atomic. The workflow skips versions already present in npm, so a
failed run can be retried to publish only the missing packages.
