# Releasing

1. Update `package.json`, `CHANGELOG.md`, `README.md`, and
   `README.zh-CN.md` together. Update `docs/goat-design.md` and visual assets
   when behavior or presentation changes.
2. Run `bun run check`, `bun run coverage:check`, `bun run build`, and
   `bun run pack:smoke`.
3. Create one candidate tarball and use it for package smoke and authenticated
   OpenCode smoke against the minimum supported CLI and `latest`.
4. Create and push the matching tag: `v<package.version>`.
5. The tag workflow verifies the candidate and publishes it with npm OIDC
   provenance. Prereleases use the `alpha` tag; `latest` is reserved for
   stable versions.
6. Verify the registry version, integrity, files, export, and dist-tag before
   announcing the GitHub prerelease.

Never publish from a dirty tree or manually repack a different tarball. Never
publish a prerelease under `latest`.
