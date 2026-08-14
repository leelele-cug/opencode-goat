# Contributing

Before opening a change:

- Run `bun install --frozen-lockfile`.
- Run `bun run check`.
- Run `bun run coverage`.
- Run `bun run build` and `bun run pack:smoke`.
- Run `bun run smoke:opencode` when authenticated OpenCode credentials and a
  smoke model are available.
- Keep a compatible OpenCode CLI on `PATH`; the smoke defaults to
  `opencode/deepseek-v4-flash-free` and accepts `OPENCODE_SMOKE_MODEL` for overrides.

Changes that affect lifecycle, workspace attribution, permissions, leases,
Session identity, or schema must include regression tests. Never include
databases, logs, credentials, or private workspace content in a change.

## Releasing

- Update `package.json` and `CHANGELOG.md` together. Update public README content
  and visual assets only when user-visible behavior or presentation changes.
- Keep internal development notes outside tracked public documentation.
- Run `bun run check`, `bun run coverage:check`, `bun run build`, and
  `bun run pack:smoke` from a clean tree.
- Create and push the matching tag `v<package.version>`. The release workflow
  validates the candidate package, runs authenticated smoke against the minimum
  and latest OpenCode CLIs, publishes prereleases under `alpha`, and creates the
  GitHub release.
- After publication, verify the npm version, integrity, package files, export,
  and dist-tag before announcing the release.
